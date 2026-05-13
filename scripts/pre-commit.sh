#!/usr/bin/env bash
# mantis pre-commit hook.
#
# Runs typecheck across server + cli + edge. Tests are intentionally NOT run
# here (they need Postgres + network); CI catches those on push/PR.
#
# Skip in an emergency with `git commit --no-verify`.

set -euo pipefail

# Only run typecheck if the index touches TypeScript files.
staged_ts=$(git diff --cached --name-only --diff-filter=ACM \
  | grep -E '\.(ts|tsx|mts|cts)$' || true)

if [ -z "$staged_ts" ]; then
  exit 0
fi

# Run from repo root regardless of where the commit was invoked from.
ROOT=$(git rev-parse --show-toplevel)
cd "$ROOT"

echo "→ typecheck (server + cli + edge) — affected by staged TS changes"
if ! npm run --silent check; then
  echo
  echo "  ✗ typecheck failed. Fix the errors, re-stage, and commit again."
  echo "    (or skip with: git commit --no-verify)"
  exit 1
fi
