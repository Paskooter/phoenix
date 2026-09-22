# Phoenix Laya intent service.
#
# The contract target deliberately has no torch/Laya/model download, so the API
# and security tests run on CI. The default model target installs a CUDA 12.8
# PyTorch wheel suitable for Blackwell hosts and loads the fixed checkpoint at
# startup. No request can select a model or supply a question definition.

FROM python:3.11-slim AS contract

WORKDIR /srv
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app
COPY profiles ./profiles
COPY tests ./tests

EXPOSE 6973
CMD ["uvicorn", "app.server:app", "--host", "0.0.0.0", "--port", "6973", "--no-access-log"]

FROM contract AS model

# CUDA 12.8 is intentional: Blackwell support is not guaranteed by the CPU
# wheel or older CUDA wheels. Keep the version range narrow and verify the
# actual device with /readyz after first boot.
RUN apt-get update && apt-get install -y --no-install-recommends libgomp1 && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir --index-url https://download.pytorch.org/whl/cu128 "torch>=2.7,<2.8"
COPY requirements-model.txt .
RUN pip install --no-cache-dir -r requirements-model.txt
RUN useradd --system --uid 10001 --create-home --home-dir /nonexistent phoenix

# The serving process uses an already-prepared local checkpoint volume.  Model
# retrieval happens only in the explicit Compose bootstrap job.
ENV LAYA_BACKEND=laya \
    LAYA_DEVICE=cuda \
    LAYA_REQUIRE_CUDA=true \
    LAYA_DEFAULT_PROFILE=phoenix-core

EXPOSE 6973
CMD ["uvicorn", "app.server:app", "--host", "0.0.0.0", "--port", "6973", "--no-access-log"]
