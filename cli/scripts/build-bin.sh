#!/usr/bin/env bash
#
# Cross-compile the mantis CLI to standalone executables for the four
# common targets:
#   - mantis-darwin-arm64   (Apple Silicon)
#   - mantis-darwin-x64     (Intel Mac)
#   - mantis-linux-arm64    (Linux ARM — Raspberry Pi 4/5, AWS Graviton, etc.)
#   - mantis-linux-x64      (Linux x86_64 — most servers/desktops)
#
# bun handles the cross-compile from any host, so this script runs the
# same on macOS, Linux, or CI without per-platform runners. bun is the
# only build-time dependency end users never see — the resulting binaries
# embed everything (no Node, no bun, no JS files).
#
# Output: cli/dist/bin/<binary> + cli/dist/bin/SHA256SUMS

set -euo pipefail

# cli/ — the dir this script's parent points at.
cd "$(dirname "$0")/.."

if ! command -v bun >/dev/null 2>&1; then
  cat >&2 <<'EOF'
error: bun is required to build the CLI binaries.

Install:
  curl -fsSL https://bun.sh/install | bash

Then re-run:
  pnpm run build:cli-bin
EOF
  exit 1
fi

ENTRY="src/index.ts"
OUT_DIR="dist/bin"
rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"

# (bun target name, output binary basename)
TARGETS=(
  "bun-darwin-arm64 mantis-darwin-arm64"
  "bun-darwin-x64   mantis-darwin-x64"
  "bun-linux-arm64  mantis-linux-arm64"
  "bun-linux-x64    mantis-linux-x64"
)

echo "==> building 4 targets from $ENTRY"
for entry in "${TARGETS[@]}"; do
  # shellcheck disable=SC2206
  parts=($entry)
  target="${parts[0]}"
  out="${parts[1]}"
  echo "  → $out"
  bun build \
    --compile \
    --minify \
    --sourcemap=none \
    --target="$target" \
    --outfile "$OUT_DIR/$out" \
    "$ENTRY"
done

echo
echo "==> sizes"
# Use cross-platform `du -h` format; macOS prints with leading whitespace.
( cd "$OUT_DIR" && ls -1 mantis-* | while read -r f; do
    printf "  %-32s %s\n" "$f" "$(du -h "$f" | cut -f1)"
done )

echo
echo "==> SHA256SUMS"
( cd "$OUT_DIR" && shasum -a 256 mantis-* | tee SHA256SUMS )

echo
echo "==> done. Binaries in cli/$OUT_DIR/"
