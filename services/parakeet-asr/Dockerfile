# Parakeet ASR REST API — a drop-in superset of the original hive_mind
# parakeet-service, adding streaming and real confidence.
#
# The original built on nvcr.io/nvidia/nemo:26.02. That image needs an NGC
# login to pull, so this installs NeMo from pip on a plain python base instead.
# Everything that decides what the robot hears is kept from the original:
#
#   * model  nvidia/parakeet-rnnt-0.6b, NOT parakeet-tdt-0.6b-v2. TDT emits
#            punctuation and capitalisation, and punctuation stops the Jibo
#            grammars dead ("turn on the lights." does not parse at all).
#   * ffmpeg resampling of any input to 16 kHz mono s16.
#   * the model resident in VRAM from startup, not loaded on first request.
#   * .wav only, 400 otherwise.
#
# Two targets:
#   --target contract   API only, no NeMo/torch/CUDA. Exercises the wire
#                       contract and the streaming protocol on any machine.
#                       Cannot transcribe.
#   (default)           the full service.

FROM python:3.10-slim AS contract

WORKDIR /srv
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1

# ffmpeg is in the base layer because resampling is part of the contract, not
# part of the model.
RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg && \
    rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt pytest httpx

COPY app ./app
COPY tests ./tests

EXPOSE 6972
CMD ["uvicorn", "app.server:app", "--host", "0.0.0.0", "--port", "6972"]

# --- full service ----------------------------------------------------------
FROM contract AS model

COPY requirements-model.txt .
RUN pip install --no-cache-dir -r requirements-model.txt
ENV PARAKEET_REQUIRE_CUDA=true PARAKEET_DEVICE=cuda

EXPOSE 6972
# PARAKEET_MODEL        nvidia/parakeet-rnnt-0.6b   model name
# PARAKEET_DEVICE       cuda                        move the model onto the GPU
# PARAKEET_REQUIRE_CUDA true                      fail readiness without CUDA
# PARAKEET_INTERIM_MS   300                         streaming interim decode window
# PARAKEET_SILENCE_RMS  200                         below this a chunk is silence
CMD ["uvicorn", "app.server:app", "--host", "0.0.0.0", "--port", "6972"]
