#!/usr/bin/env bash
# One-shot integration test runner: spins up an ephemeral Postgres in Docker,
# runs the full-stack integration suite against it (migrations applied by the
# suite's globalSetup), and tears the container down on exit.
#
# Usage: pnpm test:integration:db [-- <extra vitest args>]
set -euo pipefail

CONTAINER="${MANTIS_TEST_PG_CONTAINER:-mantis-test-pg}"
PORT="${MANTIS_TEST_PG_PORT:-5433}"
IMAGE="postgres:18-alpine"
export DATABASE_URL="postgres://mantis:mantis@localhost:${PORT}/mantis_test"
export MANTIS_API_KEY_PEPPER="${MANTIS_API_KEY_PEPPER:-integration-pepper-not-secret}"
export PUBLIC_BASE_URL="${PUBLIC_BASE_URL:-http://localhost:3000}"

KEEP="${MANTIS_TEST_PG_KEEP:-0}"

cleanup() {
  if [ "$KEEP" != "1" ]; then
    docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
echo "▸ starting $IMAGE on :$PORT ($CONTAINER)"
docker run -d --name "$CONTAINER" \
  -e POSTGRES_USER=mantis -e POSTGRES_PASSWORD=mantis -e POSTGRES_DB=mantis_test \
  -p "${PORT}:5432" "$IMAGE" >/dev/null

echo "▸ waiting for Postgres to accept connections"
docker exec "$CONTAINER" sh -c \
  'for i in $(seq 1 60); do pg_isready -U mantis -d mantis_test >/dev/null 2>&1 && exit 0; sleep 1; done; exit 1'

echo "▸ running integration suite"
vitest run --config vitest.integration.config.ts "$@"
