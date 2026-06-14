# syntax=docker/dockerfile:1.7
FROM node:25-alpine@sha256:bdf2cca6fe3dabd014ea60163eca3f0f7015fbd5c7ee1b0e9ccb4ced6eb02ef4 AS base
# Node 25's alpine image no longer bundles corepack, so install pnpm directly.
# Pinned to match packageManager in package.json / the version CI uses.
RUN npm install -g pnpm@11.1.1

FROM base AS deps
WORKDIR /app
# Manifests + lockfile first, for layer caching. Unlike the old `npm ci`
# (which couldn't work without a package-lock.json and ignored the workspace
# overrides), pnpm honours pnpm-lock.yaml and the pnpm-workspace.yaml
# overrides block — keeping the postcss / esbuild / joi CVE pins authoritative.
COPY pnpm-lock.yaml pnpm-workspace.yaml .npmrc package.json ./
COPY cli/package.json ./cli/
COPY mantis-edge/package.json ./mantis-edge/
COPY iot-helper/package.json ./iot-helper/
COPY bench/edge/package.json ./bench/edge/
# Only the root app's deps — skips the CLI's native keyring binding and the
# edge / iot / bench workspaces, which aren't part of the server image.
RUN pnpm install --frozen-lockfile --filter mantis

FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
# Build-time placeholders. These are NOT carried into the runner stage — the
# real values are supplied at runtime via the environment. env.ts validates
# DATABASE_URL / MANTIS_API_KEY_PEPPER as route modules are collected.
ARG DATABASE_URL=postgres://mantis:mantis@localhost:5432/mantis
ARG PUBLIC_BASE_URL=http://localhost:3000
ARG MANTIS_API_KEY_PEPPER=build-only-placeholder
ENV DATABASE_URL=${DATABASE_URL}
ENV PUBLIC_BASE_URL=${PUBLIC_BASE_URL}
ENV MANTIS_API_KEY_PEPPER=${MANTIS_API_KEY_PEPPER}
RUN pnpm run build

FROM node:25-alpine@sha256:bdf2cca6fe3dabd014ea60163eca3f0f7015fbd5c7ee1b0e9ccb4ced6eb02ef4 AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

RUN addgroup -S mantis && adduser -S mantis -G mantis

# Next standalone output bundles the traced runtime deps (drizzle-orm,
# postgres, the postgres-js migrator that AUTO_MIGRATE imports). The
# migrations SQL is data, not code, so it must be copied explicitly.
COPY --from=builder --chown=mantis:mantis /app/.next/standalone ./
COPY --from=builder --chown=mantis:mantis /app/.next/static ./.next/static
COPY --from=builder --chown=mantis:mantis /app/src/db/migrations ./src/db/migrations

USER mantis
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/health >/dev/null 2>&1 || exit 1

CMD ["node", "server.js"]
