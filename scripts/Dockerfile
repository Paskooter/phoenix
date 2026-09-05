FROM node:20-slim

# OGG_OPUS is decoded through ffmpeg. FLAC is decoded by the declared WASM
# package, so it needs no second system decoder in the runtime image.
RUN apt-get update \
  && apt-get install --no-install-recommends --yes ca-certificates ffmpeg \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    PHOENIX_FFMPEG=/usr/bin/ffmpeg

WORKDIR /phoenix
COPY . .

# Install the reviewed dependency versions into the image. Compose leaves this
# directory in the image, so rebuilding also updates the runtime dependencies.
RUN npm ci --ignore-scripts --omit=dev --no-audit --no-fund

CMD ["node", "packages/gateway/src/index.js"]
