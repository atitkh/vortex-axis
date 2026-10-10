#!/usr/bin/env python3
"""Speech recognition: NVIDIA NeMo Parakeet TDT-CTC 110M (int8) through
sherpa-onnx, behind OpenAI's POST /v1/audio/transcriptions.

Parakeet has no server or API of its own; this gives it OpenAI's, so a client
that asks for "whisper-1" gets Parakeet. It takes any sample rate and answers
json (the default), text, verbose_json, srt or vtt. Short commands come back
in a fraction of a second on two CPU threads."""
import os
import threading
import time

import numpy as np
import sherpa_onnx

from common import Handler, NUM_THREADS, RELEASES, decode_audio, fetch_model, log, read_upload, serve

MODEL = os.environ.get("STT_MODEL", "sherpa-onnx-nemo-parakeet_tdt_ctc_110m-en-36000-int8")

folder = fetch_model(MODEL, f"{RELEASES}/asr-models/{MODEL}.tar.bz2")
log("loading Parakeet")
recognizer = sherpa_onnx.OfflineRecognizer.from_nemo_ctc(
    model=os.path.join(folder, "model.int8.onnx"),
    tokens=os.path.join(folder, "tokens.txt"),
    num_threads=NUM_THREADS,
)
# One at a time: two at once would only split the same threads.
lock = threading.Lock()


def transcribe(samples, rate):
    with lock:
        stream = recognizer.create_stream()
        stream.accept_waveform(rate, samples)
        recognizer.decode_stream(stream)
        return stream.result.text.strip()


# The first decode pays ONNX Runtime's start-up cost; pay it before any request does.
transcribe(np.zeros(16000, dtype=np.float32), 16000)
log("ready")


def timestamp(seconds, sep):
    ms = int(round(seconds * 1000))
    h, ms = divmod(ms, 3600000)
    m, ms = divmod(ms, 60000)
    s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d}{sep}{ms:03d}"


class Stt(Handler):
    models = ["parakeet-tdt-ctc-110m", "whisper-1"]
    engine = "parakeet-tdt-ctc-110m"

    def do_POST(self):
        # /inference is whisper.cpp's server path; some clients still use it.
        if self.path not in ("/v1/audio/transcriptions", "/inference"):
            return self.send_json(404, {"error": "not found"})
        try:
            fields, data = read_upload(self)
            samples, rate = decode_audio(data)
        except Exception as e:
            return self.send_json(400, {"error": "could not read audio", "detail": str(e)})
        started = time.time()
        try:
            text = transcribe(samples, rate) if len(samples) else ""
        except Exception as e:
            return self.send_json(500, {"error": "transcription failed", "detail": str(e)})
        duration = len(samples) / rate if rate else 0.0
        log(f"transcribed {duration:.2f}s of audio in {time.time() - started:.2f}s")

        fmt = fields.get("response_format", "json")
        if fmt == "text":
            self.send_body(200, text + "\n", "text/plain; charset=utf-8")
        elif fmt == "verbose_json":
            self.send_json(200, {
                "task": "transcribe", "language": "english", "duration": round(duration, 2), "text": text,
                "segments": [{"id": 0, "start": 0.0, "end": round(duration, 2), "text": text}],
            })
        elif fmt == "srt":
            self.send_body(200, f"1\n{timestamp(0, ',')} --> {timestamp(duration, ',')}\n{text}\n", "text/plain; charset=utf-8")
        elif fmt == "vtt":
            self.send_body(200, f"WEBVTT\n\n{timestamp(0, '.')} --> {timestamp(duration, '.')}\n{text}\n", "text/vtt; charset=utf-8")
        else:
            self.send_json(200, {"text": text})


if __name__ == "__main__":
    serve(Stt)
