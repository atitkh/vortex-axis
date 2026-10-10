#!/usr/bin/env python3
"""Voiceprints: a speaker-embedding model (WeSpeaker ResNet34, trained on
VoxCeleb) through sherpa-onnx.

POST /v1/speaker/embed with an audio file (a multipart `file` part, or the
file as the whole body) answers {"embedding": [...], "dim": n, "seconds": s}:
a vector that is close for two recordings of the same voice and far for two
different ones. The service keeps nothing; comparing voices is the caller's
business. OpenAI has no API for this, so the shape is our own."""
import os
import threading
import time

import numpy as np
import sherpa_onnx

from common import Handler, NUM_THREADS, RELEASES, decode_audio, fetch_model, log, read_upload, serve

MODEL = os.environ.get("VOICEPRINT_MODEL", "wespeaker_en_voxceleb_resnet34_LM.onnx")
RATE = 16000

model = fetch_model(MODEL, f"{RELEASES}/speaker-recongition-models/{MODEL}", archive=False)
log("loading the speaker model")
extractor = sherpa_onnx.SpeakerEmbeddingExtractor(
    sherpa_onnx.SpeakerEmbeddingExtractorConfig(model=model, num_threads=NUM_THREADS, debug=False)
)
lock = threading.Lock()


def embed(samples, rate):
    with lock:
        stream = extractor.create_stream()
        stream.accept_waveform(rate, samples)
        stream.input_finished()
        if not extractor.is_ready(stream):
            raise ValueError("too short to tell a voice from")
        return np.array(extractor.compute(stream), dtype=np.float32)


embed(np.random.default_rng(0).normal(0, 0.05, RATE).astype(np.float32), RATE)
log(f"ready, {extractor.dim} numbers per voiceprint")


class Voiceprint(Handler):
    models = [MODEL.removesuffix(".onnx")]
    engine = MODEL.removesuffix(".onnx")

    def do_POST(self):
        if self.path != "/v1/speaker/embed":
            return self.send_json(404, {"error": "not found"})
        try:
            _, data = read_upload(self)
            samples, rate = decode_audio(data)
        except Exception as e:
            return self.send_json(400, {"error": "could not read audio", "detail": str(e)})
        started = time.time()
        try:
            vector = embed(samples, rate)
        except ValueError as e:
            return self.send_json(422, {"error": str(e)})
        except Exception as e:
            return self.send_json(500, {"error": "embedding failed", "detail": str(e)})
        seconds = len(samples) / rate if rate else 0.0
        log(f"voiceprint of {seconds:.2f}s in {time.time() - started:.3f}s")
        self.send_json(200, {"embedding": [round(float(v), 6) for v in vector], "dim": int(vector.size), "seconds": round(seconds, 2)})


if __name__ == "__main__":
    serve(Voiceprint)
