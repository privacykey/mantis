#!/usr/bin/env bash
# Symlinks ./scripts/pre-commit.sh into .git/hooks/pre-commit.
# Idempotent. Backs up an existing hook to .pre-commit.bak.

set -euo pipefail

ROOT=$(git rev-parse --show-toplevel 2>/dev/null || true)
if [ -z "$ROOT" ]; then
  echo "✗ not in a git repository" >&2
  exit 1
fi
cd "$ROOT"

SRC="$ROOT/scripts/pre-commit.sh"
DEST="$ROOT/.git/hooks/pre-commit"

if [ ! -f "$SRC" ]; then
  echo "✗ source hook missing: $SRC" >&2
  exit 1
fi

chmod +x "$SRC"

mkdir -p "$ROOT/.git/hooks"

# Already installed? Bail.
if [ -L "$DEST" ] && [ "$(readlink "$DEST")" = "$SRC" ]; then
  echo "✓ pre-commit hook already installed → $SRC"
  exit 0
fi

# Backup any existing real file.
if [ -e "$DEST" ] && [ ! -L "$DEST" ]; then
  mv "$DEST" "$DEST.bak"
  echo "  (existing hook backed up to $DEST.bak)"
fi

ln -sf "$SRC" "$DEST"
echo "✓ installed pre-commit hook → $DEST"
echo "  runs \`npm run check\` when TS files are staged. Skip with --no-verify."
