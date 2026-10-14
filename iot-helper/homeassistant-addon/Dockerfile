# Keep the same pinned Node runtime as the standalone IoT helper. Supervisor
# no longer supplies BUILD_FROM when building a local add-on.
FROM node:26-alpine@sha256:3ad34ca6292aec4a91d8ddeb9229e29d9c2f689efd0dd242860889ac71842eba

ARG BUILD_VERSION=0.1.0
ARG BUILD_ARCH
LABEL io.hass.version="$BUILD_VERSION" \
      io.hass.type="app" \
      io.hass.arch="$BUILD_ARCH"

RUN apk add --no-cache iproute2 iputils

WORKDIR /app
COPY package.json ./
COPY bin ./bin
COPY run.sh /run.sh
RUN chmod +x /run.sh

CMD ["/run.sh"]
