#!/usr/bin/env python3
"""Speech synthesis: Supertone's Supertonic 3 (int8) through sherpa-onnx,
behind OpenAI's POST /v1/audio/speech.

Supertonic has no server of its own; this gives it OpenAI's, so a client that
asks for "tts-1" gets Supertonic. Ten preset voices: "voice": "0" to "9"
(0-4 higher, 5-9 lower); any other name gets DEFAULT_VOICE. Audio is 24 kHz
16-bit mono, the rate OpenAI's pcm format uses.

Optional fields beyond OpenAI's: "steps" (1-10, default 5: fewer is quicker
and rougher), "sentence_gap" (seconds between streamed sentences) and
"stream": true with response_format pcm, which sends each sentence as soon as
it is made, chunked, so sound can start after the first sentence."""
import os
import re
import struct
import threading
import time

import numpy as np
import sherpa_onnx
import soundfile as sf
import soxr

from common import Handler, NUM_THREADS, RELEASES, fetch_model, float_to_pcm, log, serve

MODEL = os.environ.get("TTS_MODEL", "sherpa-onnx-supertonic-3-tts-int8-2026-05-11")
DEFAULT_VOICE = int(os.environ.get("DEFAULT_VOICE", "1"))
SAMPLE_RATE = 24000
DEFAULT_STEPS = 5
MAX_STEPS = 10

folder = fetch_model(MODEL, f"{RELEASES}/tts-models/{MODEL}.tar.bz2")
log("loading Supertonic")
path = lambda name: os.path.join(folder, name)
tts = sherpa_onnx.OfflineTts(sherpa_onnx.OfflineTtsConfig(
    model=sherpa_onnx.OfflineTtsModelConfig(
        supertonic=sherpa_onnx.OfflineTtsSupertonicModelConfig(
            duration_predictor=path("duration_predictor.int8.onnx"),
            text_encoder=path("text_encoder.int8.onnx"),
            vector_estimator=path("vector_estimator.int8.onnx"),
            vocoder=path("vocoder.int8.onnx"),
            tts_json=path("tts.json"),
            unicode_indexer=path("unicode_indexer.bin"),
            voice_style=path("voice.bin"),
        ),
        num_threads=NUM_THREADS,
        debug=False,
    ),
))
VOICES = tts.num_speakers or 1
# One at a time: two at once would only split the same threads.
lock = threading.Lock()


def config(voice, speed, steps):
    cfg = sherpa_onnx.GenerationConfig()
    try:
        sid = int(voice)
    except (TypeError, ValueError):
        sid = DEFAULT_VOICE
    cfg.sid = sid if 0 <= sid < VOICES else DEFAULT_VOICE
    try:
        cfg.speed = float(speed) if speed else 1.0
    except (TypeError, ValueError):
        cfg.speed = 1.0
    try:
        cfg.num_steps = min(max(int(steps), 1), MAX_STEPS)
    except (TypeError, ValueError):
        cfg.num_steps = DEFAULT_STEPS
    return cfg


def generate(text, cfg):
    with lock:
        return tts.generate(text, cfg)


# The first call is several times slower than the rest; pay it before any request does.
generate("Warming up.", config(DEFAULT_VOICE, 1.0, DEFAULT_STEPS))
log(f"ready, {VOICES} voices")

# Every clip comes with a lead and a tail of near silence from the model. Both
# are trimmed: 20 ms is kept ahead, and a fixed pause after, so a client
# playing one clip per sentence back to back hears an even pause between them.
SILENCE = 0.01
LEAD_SEC = 0.02
GAP_SEC = 0.6
MAX_GAP_SEC = 2.0
LAST_TAIL_SEC = 0.15
# Streamed sentences: a short first piece leaves playback waiting on the second.
SENTENCE_END = re.compile(r"(?<=[.!?])\s+")
MIN_SENTENCE_CHARS = 12
MIN_FIRST_CHARS = 40
# Some small HTTP clients read 4096 bytes at a time and allocate per chunk: no small chunks.
CHUNK_BYTES = 4096


def trim(samples, rate, tail_sec):
    x = np.asarray(samples, dtype=np.float32)
    loud = np.flatnonzero(np.abs(x) > SILENCE)
    if loud.size == 0:
        return x
    start = max(loud[0] - int(LEAD_SEC * rate), 0)
    end = loud[-1] + 1
    gap = int(tail_sec * rate)
    tail = x[end:end + gap]
    return np.concatenate([x[start:end], tail, np.zeros(gap - tail.size, dtype=np.float32)])


def to_rate(samples, rate):
    x = np.asarray(samples, dtype=np.float32)
    return soxr.resample(x, rate, SAMPLE_RATE, quality="HQ") if rate != SAMPLE_RATE else x


def wav(pcm):
    return (b"RIFF" + struct.pack("<I", 36 + len(pcm)) + b"WAVEfmt "
            + struct.pack("<IHHIIHH", 16, 1, 1, SAMPLE_RATE, SAMPLE_RATE * 2, 2, 16)
            + b"data" + struct.pack("<I", len(pcm)) + pcm)


def split_sentences(text):
    out, carry = [], ""
    for part in SENTENCE_END.split(text.strip()):
        carry = (carry + " " + part).strip() if carry else part.strip()
        if len(carry) >= (MIN_SENTENCE_CHARS if out else MIN_FIRST_CHARS):
            out.append(carry)
            carry = ""
    if carry:
        if out and len(carry) < MIN_SENTENCE_CHARS:
            out[-1] += " " + carry
        else:
            out.append(carry)
    return out


class Tts(Handler):
    models = ["supertonic-3", "tts-1", "tts-1-hd"]
    engine = "supertonic-3"

    def do_POST(self):
        if self.path != "/v1/audio/speech":
            return self.send_json(404, {"error": "not found"})
        try:
            import json
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
        except Exception:
            return self.send_json(400, {"error": "invalid JSON body"})
        text = body.get("input")
        if not isinstance(text, str) or not text.strip():
            return self.send_json(400, {"error": "missing 'input'"})
        fmt = body.get("response_format", "mp3")
        cfg = config(body.get("voice"), body.get("speed"), body.get("steps", DEFAULT_STEPS))
        try:
            gap = min(max(float(body.get("sentence_gap", GAP_SEC)), 0.0), MAX_GAP_SEC)
        except (TypeError, ValueError):
            gap = GAP_SEC
        if body.get("stream") is True and fmt == "pcm":
            return self.stream(text, cfg, gap)

        started = time.time()
        try:
            audio = generate(text, cfg)
        except Exception as e:
            return self.send_json(500, {"error": "synthesis failed", "detail": str(e)})
        samples = to_rate(trim(audio.samples, audio.sample_rate, gap), audio.sample_rate)
        log(f"made {len(samples) / SAMPLE_RATE:.2f}s of speech in {time.time() - started:.2f}s")
        if fmt == "pcm":
            data, content_type = float_to_pcm(samples), "audio/pcm"
        elif fmt in ("mp3", "flac", "ogg", "opus"):
            import io
            out = io.BytesIO()
            kind = {"mp3": ("MP3", None), "flac": ("FLAC", None), "ogg": ("OGG", "VORBIS"), "opus": ("OGG", "OPUS")}[fmt]
            sf.write(out, samples, SAMPLE_RATE, format=kind[0], subtype=kind[1])
            data, content_type = out.getvalue(), {"mp3": "audio/mpeg", "flac": "audio/flac"}.get(fmt, "audio/ogg")
        else:
            data, content_type = wav(float_to_pcm(samples)), "audio/wav"
        self.send_body(200, data, content_type)

    def chunk(self, data):
        self.wfile.write(b"%x\r\n" % len(data) + data + b"\r\n")

    def stream(self, text, cfg, gap):
        sentences = split_sentences(text)
        started, pending = False, b""
        for n, sentence in enumerate(sentences):
            tail = gap if n < len(sentences) - 1 else LAST_TAIL_SEC
            try:
                audio = generate(sentence, cfg)
                pcm = float_to_pcm(to_rate(trim(audio.samples, audio.sample_rate, tail), audio.sample_rate))
            except Exception as e:
                if not started:
                    return self.send_json(500, {"error": "synthesis failed", "detail": str(e)})
                # Closed without the last empty chunk, so the client can tell a broken clip from a whole one.
                log(f"stream stopped mid-clip: {e}")
                self.close_connection = True
                return
            try:
                if not started:
                    # Chunked needs HTTP/1.1, the exact value "chunked", and no Content-Length.
                    self.protocol_version = "HTTP/1.1"
                    self.send_response(200)
                    self.send_header("Content-Type", "audio/pcm")
                    self.send_header("Transfer-Encoding", "chunked")
                    self.send_header("Cache-Control", "no-cache")
                    self.send_header("Connection", "close")
                    self.end_headers()
                    self.close_connection = True
                    started = True
                pending += pcm
                whole = len(pending) - len(pending) % CHUNK_BYTES
                for k in range(0, whole, CHUNK_BYTES):
                    self.chunk(pending[k:k + CHUNK_BYTES])
                pending = pending[whole:]
                self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                return  # the client hung up; stop making speech
        try:
            if pending:
                self.chunk(pending.ljust(CHUNK_BYTES, b"\0"))
            self.wfile.write(b"0\r\n\r\n")
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass


if __name__ == "__main__":
    serve(Tts)
