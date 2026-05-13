# syntax=docker/dockerfile:1.7
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=optional

FROM node:24-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
ARG DATABASE_URL=postgres://mantis:mantis@localhost:5432/mantis
ARG PUBLIC_BASE_URL=http://localhost:3000
ENV DATABASE_URL=${DATABASE_URL}
ENV PUBLIC_BASE_URL=${PUBLIC_BASE_URL}
RUN npm run build

FROM node:24-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

RUN addgroup -S mantis && adduser -S mantis -G mantis

COPY --from=builder --chown=mantis:mantis /app/.next/standalone ./
COPY --from=builder --chown=mantis:mantis /app/.next/static ./.next/static
COPY --from=builder --chown=mantis:mantis /app/src/db/migrations ./src/db/migrations
COPY --from=builder --chown=mantis:mantis /app/drizzle.config.ts ./drizzle.config.ts
COPY --from=builder --chown=mantis:mantis /app/node_modules/drizzle-kit ./node_modules/drizzle-kit
COPY --from=builder --chown=mantis:mantis /app/node_modules/drizzle-orm ./node_modules/drizzle-orm
COPY --from=builder --chown=mantis:mantis /app/package.json ./package.json

USER mantis
EXPOSE 3000
CMD ["node", "server.js"]
