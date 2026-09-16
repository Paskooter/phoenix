# Parakeet ASR REST API — a drop-in superset of the original hive_mind
# parakeet-service, adding streaming and real confidence.
#
# Modelled on that service deliberately: same NeMo base image, same model, same
# ffmpeg resampling, same VRAM-resident startup, same .wav contract. Those are
# not incidental — the model choice in particular decides what the robot hears,
# because parakeet-tdt-0.6b-v2 emits punctuation and the Jibo grammars cannot
# parse it ("turn on the lights." does not match at all).
FROM nvcr.io/nvidia/nemo:26.02

WORKDIR /workspace

# ffmpeg for automatic resampling, plus the API stack. websockets is the one
# addition over the original, for the streaming endpoint.
RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg && \
    rm -rf /var/lib/apt/lists/* && \
    pip install --no-cache-dir fastapi uvicorn python-multipart websockets \
      lhotse editdistance jiwer

COPY app /workspace/app
COPY tests /workspace/tests

EXPOSE 6972

# PARAKEET_MODEL        nvidia/parakeet-rnnt-0.6b   model name
# PARAKEET_DEVICE       (unset)                     e.g. cuda; unset lets NeMo decide
# PARAKEET_INTERIM_MS   300                         streaming interim decode window
# PARAKEET_SILENCE_RMS  200                         below this a chunk is silence
CMD ["uvicorn", "app.server:app", "--host", "0.0.0.0", "--port", "6972"]
