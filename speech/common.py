"""What the three speech services share: settings from the environment, the
models fetched on first start, audio decoding and a small HTTP server.

Every service is a plain stdlib HTTP server around one sherpa-onnx model,
answering in the shape OpenAI's audio API uses, so anything that speaks that
API can use it whatever model is behind it."""
import io
import json
import os
import shutil
import sys
import tarfile
import tempfile
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
import soundfile as sf

MODELS_DIR = os.environ.get("MODELS_DIR", "/models")
NUM_THREADS = int(os.environ.get("NUM_THREADS", "2"))
PORT = int(os.environ.get("PORT", "8000"))
RELEASES = "https://github.com/k2-fsa/sherpa-onnx/releases/download"


def log(message):
    print(message, flush=True)


def fetch_model(name, url, archive=True):
    """Returns the folder (or file) a model lives in under MODELS_DIR, fetching
    it first if it is not there yet. A half-finished download never counts:
    it is unpacked in a temporary folder and moved into place at the end."""
    target = os.path.join(MODELS_DIR, name)
    if os.path.exists(target):
        return target
    os.makedirs(MODELS_DIR, exist_ok=True)
    log(f"fetching {name} from {url}")
    started = time.time()
    with tempfile.TemporaryDirectory(dir=MODELS_DIR) as work:
        download = os.path.join(work, "download")
        with urllib.request.urlopen(url, timeout=60) as res, open(download, "wb") as out:
            shutil.copyfileobj(res, out, 1 << 20)
        if archive:
            unpacked = os.path.join(work, "unpacked")
            with tarfile.open(download) as tar:
                tar.extractall(unpacked, filter="data")
            entries = os.listdir(unpacked)
            # The archives hold one folder; take what is inside it.
            source = os.path.join(unpacked, entries[0]) if len(entries) == 1 else unpacked
        else:
            source = download
        os.replace(source, target)
    log(f"fetched {name} in {time.time() - started:.0f}s")
    return target


def decode_audio(data):
    """Any audio libsndfile reads (wav, flac, ogg, mp3), at any rate, as mono float32."""
    samples, rate = sf.read(io.BytesIO(data), dtype="float32", always_2d=True)
    return samples.mean(axis=1), rate


def parse_multipart(content_type, body):
    import email.parser
    import email.policy

    msg = email.parser.BytesParser(policy=email.policy.HTTP).parsebytes(
        b"Content-Type: " + content_type.encode() + b"\r\n\r\n" + body
    )
    fields, file_data = {}, None
    for part in msg.iter_parts():
        name = part.get_param("name", header="content-disposition")
        payload = part.get_payload(decode=True) or b""
        if part.get_filename() is not None or name == "file":
            file_data = payload
        elif name:
            fields[name] = payload.decode("utf-8", "replace")
    return fields, file_data


def read_upload(handler, max_bytes=50 * 1024 * 1024):
    """The audio of a POST: a multipart form with a `file` part, as OpenAI's API
    takes it, or the audio file as the whole body. Returns (fields, bytes)."""
    length = int(handler.headers.get("Content-Length", 0))
    if length <= 0 or length > max_bytes:
        raise ValueError("missing or oversized body")
    body = handler.rfile.read(length)
    content_type = handler.headers.get("Content-Type", "")
    if content_type.startswith("multipart/form-data"):
        fields, data = parse_multipart(content_type, body)
        if not data:
            raise ValueError("missing 'file'")
        return fields, data
    return {}, body


class Handler(BaseHTTPRequestHandler):
    """Answers the model list and health on GET. Services add do_POST."""

    models = []
    engine = ""

    def log_message(self, fmt, *args):
        log("%s - %s" % (self.address_string(), fmt % args))

    def send_body(self, code, body, content_type):
        if isinstance(body, str):
            body = body.encode()
        try:
            self.send_response(code)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            # The caller gave up waiting before the answer was ready. Nothing to send it to.
            log(f"{self.address_string()} hung up before the answer was sent")
            self.close_connection = True

    def send_json(self, code, obj):
        self.send_body(code, json.dumps(obj), "application/json")

    def do_GET(self):
        if self.path in ("/v1/models", "/models"):
            self.send_json(200, {
                "object": "list",
                "data": [{"id": m, "object": "model", "created": 0, "owned_by": "vortex-axis"} for m in self.models],
            })
        elif self.path in ("/", "/health", "/healthz"):
            self.send_json(200, {"status": "ok", "engine": self.engine})
        else:
            self.send_json(404, {"error": "not found"})


def serve(handler):
    class Server(ThreadingHTTPServer):
        allow_reuse_address = True
        daemon_threads = True

    server = Server(("0.0.0.0", PORT), handler)
    log(f"{handler.engine} listening on :{PORT}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        sys.exit(0)


def float_to_pcm(samples):
    return (np.clip(np.asarray(samples, dtype=np.float32), -1.0, 1.0) * 32767.0).astype("<i2").tobytes()
