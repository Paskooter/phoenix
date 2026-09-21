FROM node:20-slim

# OGG_OPUS is decoded through ffmpeg. FLAC is decoded by the declared WASM
# package, so it needs no second system decoder in the runtime image.
RUN apt-get update \
  && apt-get install --no-install-recommends --yes ca-certificates ffmpeg \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    PHOENIX_FFMPEG=/usr/bin/ffmpeg \
    HOME=/home/node

WORKDIR /phoenix
# WORKDIR is created by Docker as root. Give the unprivileged build/runtime
# user ownership of the application directory before npm creates node_modules.
RUN chown node:node /phoenix
# The runtime image must not contain operator state. .dockerignore excludes
# account/OTA data, local environment files, credentials, logs and build output.
# Keep the image owned by the unprivileged runtime user from the first layer.
COPY --chown=node:node . .

# Install the reviewed dependency versions into the image. Compose leaves this
# directory in the image, so rebuilding also updates the runtime dependencies.
USER node
RUN npm ci --ignore-scripts --omit=dev --no-audit --no-fund \
  && npm cache clean --force

# Keep the application root itself non-writable even when this image is run
# outside the hardened Compose read-only rootfs.
USER root
RUN chown root:root /phoenix && chmod 0555 /phoenix
USER node
CMD ["node", "packages/gateway/src/index.js"]
