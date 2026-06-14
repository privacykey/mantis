# Match the project's Node engine (>=25.8.0) so the container runtime tracks CI.
# Digest-pinned for reproducible pulls (Dependabot's docker ecosystem bumps it).
FROM node:26-alpine@sha256:3ad34ca6292aec4a91d8ddeb9229e29d9c2f689efd0dd242860889ac71842eba

# arp / `ip neigh` are passive neighbour-table reads (no privileges needed).
# `ping` active probes need CAP_NET_RAW when running as non-root — grant it
# (docker run --cap-add=NET_RAW, or --sysctl net.ipv4.ping_group_range=...)
# only if you enable `ping` probes in the config; passive detection works
# without any added capability.
RUN apk add --no-cache iproute2 iputils \
  && addgroup -S mantis && adduser -S mantis -G mantis \
  && mkdir -p /config && chown -R mantis:mantis /config

WORKDIR /app
COPY --chown=mantis:mantis package.json ./
COPY --chown=mantis:mantis bin ./bin
COPY --chown=mantis:mantis config.example.json ./config.example.json

ENV MANTIS_IOT_CONFIG=/config/mantis-iot.json
VOLUME ["/config"]

USER mantis

# The helper can't run without a readable, valid-JSON config, so use that as
# the liveness signal. Unhealthy until the operator mounts /config.
HEALTHCHECK --interval=60s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "JSON.parse(require('fs').readFileSync(process.env.MANTIS_IOT_CONFIG,'utf8'))" || exit 1

CMD ["node", "bin/mantis-iot-helper.js"]
