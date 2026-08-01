#!/usr/bin/env bash
# One-shot Tier-2 e2e runner: ephemeral Docker Postgres → `next build` →
# standalone production server (`node .next/standalone/server.js`, the same
# entrypoint docker/Dockerfile uses) → the tests/tier2 suite over real HTTP.
#
# Usage: pnpm test:tier2 [-- <extra vitest args>]
#
# Knobs (all optional):
#   MANTIS_TIER2_PORT             app port (default 3891)
#   MANTIS_TIER2_PG_CONTAINER     pg container name (default mantis-tier2-pg)
#   MANTIS_TIER2_PG_PORT          pg host port (default 5434)
#   MANTIS_TIER2_PG_KEEP=1        leave the pg container running on exit
#   MANTIS_TIER2_USE_EXISTING_DB=1  skip Docker; requires DATABASE_URL (CI)
#   MANTIS_TIER2_SKIP_BUILD=1     reuse an existing .next standalone build
set -euo pipefail

PORT="${MANTIS_TIER2_PORT:-3891}"
PG_CONTAINER="${MANTIS_TIER2_PG_CONTAINER:-mantis-tier2-pg}"
PG_PORT="${MANTIS_TIER2_PG_PORT:-5434}"
USE_EXISTING_DB="${MANTIS_TIER2_USE_EXISTING_DB:-0}"
SKIP_BUILD="${MANTIS_TIER2_SKIP_BUILD:-0}"
IMAGE="postgres:18-alpine"

if [ "$USE_EXISTING_DB" = "1" ]; then
  : "${DATABASE_URL:?MANTIS_TIER2_USE_EXISTING_DB=1 requires DATABASE_URL}"
else
  export DATABASE_URL="postgres://mantis:mantis@localhost:${PG_PORT}/mantis_test"
fi
export MANTIS_API_KEY_PEPPER="${MANTIS_API_KEY_PEPPER:-integration-pepper-not-secret}"
export PUBLIC_BASE_URL="${PUBLIC_BASE_URL:-http://localhost:${PORT}}"
# The host-split gate under test. The vitest process reads the same variables
# (tests/tier2/_client.ts) so client expectations always match server config.
export PUBLIC_ONLY_HOSTS="${PUBLIC_ONLY_HOSTS:-public.mantis.test}"
export DASHBOARD_HOSTS="${DASHBOARD_HOSTS:-dash.mantis.test}"
export MANTIS_TIER2_BASE_URL="http://127.0.0.1:${PORT}"

DASH_HOST="${DASHBOARD_HOSTS%%[ ,]*}"

SERVER_PID=""
cleanup() {
  if [ -n "$SERVER_PID" ]; then
    kill "$SERVER_PID" 2>/dev/null || true
  fi
  if [ "$USE_EXISTING_DB" != "1" ] && [ "${MANTIS_TIER2_PG_KEEP:-0}" != "1" ]; then
    docker rm -f "$PG_CONTAINER" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

if [ "$USE_EXISTING_DB" != "1" ]; then
  docker rm -f "$PG_CONTAINER" >/dev/null 2>&1 || true
  echo "▸ starting $IMAGE on :$PG_PORT ($PG_CONTAINER)"
  docker run -d --name "$PG_CONTAINER" \
    -e POSTGRES_USER=mantis -e POSTGRES_PASSWORD=mantis -e POSTGRES_DB=mantis_test \
    -p "${PG_PORT}:5432" "$IMAGE" >/dev/null
  echo "▸ waiting for Postgres to accept connections"
  docker exec "$PG_CONTAINER" sh -c \
    'for i in $(seq 1 60); do pg_isready -U mantis -d mantis_test >/dev/null 2>&1 && exit 0; sleep 1; done; exit 1'
fi

# Canonical location first (turbopack.root pins it there); fall back to a
# search in case an unusual workspace layout still nests the output.
locate_server_js() {
  if [ -f .next/standalone/server.js ]; then
    echo ".next/standalone/server.js"
  else
    find .next/standalone -maxdepth 5 -name server.js 2>/dev/null | head -1
  fi
}

# Migrate BEFORE the server boots: its bootstrap/notify-worker touch the
# schema immediately and log noisy (harmless) failures against an empty DB.
# The suite's globalSetup re-applies migrations idempotently.
echo "▸ applying migrations"
pnpm run db:migrate

if [ "$SKIP_BUILD" = "1" ] && [ -n "$(locate_server_js)" ]; then
  echo "▸ reusing existing standalone build (MANTIS_TIER2_SKIP_BUILD=1)"
else
  echo "▸ next build (standalone output)"
  pnpm run build
fi

SERVER_JS="$(locate_server_js)"
if [ -z "$SERVER_JS" ]; then
  echo "✗ no server.js under .next/standalone — is output:'standalone' set?" >&2
  exit 1
fi
STANDALONE_DIR="$(dirname "$SERVER_JS")"

# Standalone output doesn't include static assets; mirror what the Dockerfile
# does so served pages are complete (the suite itself never fetches them).
mkdir -p "$STANDALONE_DIR/.next"
cp -R .next/static "$STANDALONE_DIR/.next/" 2>/dev/null || true

# Anything already answering on the port means the suite would silently test
# the WRONG server (e.g. a local mantis stack in Docker). Fail loudly instead.
if curl -s -o /dev/null --max-time 2 "http://127.0.0.1:${PORT}/"; then
  echo "✗ something is already listening on :$PORT — set MANTIS_TIER2_PORT to a free port" >&2
  exit 1
fi

# Absolute path: server.js chdirs into its own directory on startup, which
# breaks node's resolution of a relative script path.
SERVER_JS_ABS="$(cd "$(dirname "$SERVER_JS")" && pwd)/$(basename "$SERVER_JS")"

echo "▸ starting standalone server on :$PORT ($SERVER_JS)"
PORT="$PORT" HOSTNAME=127.0.0.1 node "$SERVER_JS_ABS" &
SERVER_PID=$!

echo "▸ waiting for server readiness (dashboard-host /api/health)"
ready=0
for _ in $(seq 1 60); do
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "✗ server exited during startup" >&2
    exit 1
  fi
  code="$(curl -s -o /dev/null -w '%{http_code}' -H "Host: ${DASH_HOST}" \
    "http://127.0.0.1:${PORT}/api/health" || true)"
  if [ "$code" = "200" ]; then
    ready=1
    break
  fi
  sleep 1
done
if [ "$ready" != "1" ]; then
  echo "✗ server never became ready on :$PORT" >&2
  exit 1
fi
# Belt-and-braces: the 200 above must have come from OUR process, not a
# neighbour that grabbed the port between the pre-flight check and now.
if ! kill -0 "$SERVER_PID" 2>/dev/null; then
  echo "✗ standalone server exited — the readiness 200 came from another process" >&2
  exit 1
fi

echo "▸ running tier-2 suite"
vitest run --config vitest.tier2.config.ts "$@"
