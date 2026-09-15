# Parakeet ASR REST API — drop-in superset of the deployed 0.1.0 server.
#
# Adds interim results over a WebSocket (so the hub's earlyEOS can fire) and
# real decoder confidence, while POST /transcribe stays byte-compatible for the
# two existing clients.
#
# Built in two stages so the contract layer is not rebuilt when the model layer
# changes, and so a CPU-only smoke test can stop at `service`.
FROM python:3.10-slim AS service

WORKDIR /srv
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app
COPY tests ./tests

EXPOSE 6972
# PARAKEET_MODEL    NeMo model name          (default nvidia/parakeet-tdt-0.6b-v2)
# PARAKEET_DEVICE   cuda | cpu               (default cuda)
# PARAKEET_INTERIM_MS  interim decode window (default 300)
# PARAKEET_SILENCE_RMS below this is silence  (default 200)
CMD ["uvicorn", "app.server:app", "--host", "0.0.0.0", "--port", "6972"]

# The model layer. Kept last so `--target service` builds without CUDA wheels.
FROM service AS model
COPY requirements-model.txt .
RUN pip install --no-cache-dir -r requirements-model.txt
CMD ["uvicorn", "app.server:app", "--host", "0.0.0.0", "--port", "6972"]
