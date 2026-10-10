# Local speech for Axis: one image, three services (stt.py, tts.py, voiceprint.py),
# chosen by the command compose.yaml gives each. Models are not in the image:
# each service fetches its own into /models on first start.
FROM python:3.12-slim
ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    MODELS_DIR=/models
RUN pip install sherpa-onnx==1.13.8 numpy soundfile soxr
WORKDIR /app
COPY common.py stt.py tts.py voiceprint.py ./
RUN useradd --uid 1000 --no-create-home speech && mkdir -p /models && chown speech /models
USER speech
VOLUME /models
HEALTHCHECK --interval=30s --timeout=3s --start-period=600s \
  CMD python -c "import os,urllib.request; urllib.request.urlopen(f'http://127.0.0.1:{os.environ.get(\"PORT\",\"8000\")}/health', timeout=2)" || exit 1
CMD ["python", "stt.py"]
