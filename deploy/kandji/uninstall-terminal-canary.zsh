#!/bin/zsh
# Removes the Mantis terminal canary from this machine: deletes the managed
# block from /etc/zprofile and the state directory. The canary key itself
# stays on the Mantis server (disable or delete it from the dashboard/API —
# an enrollment-scoped key can't, by design).
#
# Run as a Kandji Custom Script on offboarding, or manually with sudo.

set -u

ZPROFILE="/etc/zprofile"
STATE_DIR="/Library/Application Support/Mantis"
MARK_BEGIN="# BEGIN MANTIS TERMINAL CANARY (managed — do not edit)"
MARK_END="# END MANTIS TERMINAL CANARY"

if [[ $EUID -ne 0 ]]; then
  echo "must run as root" >&2
  exit 1
fi

if [[ -f "$ZPROFILE" ]] && grep -qxF "$MARK_BEGIN" "$ZPROFILE"; then
  tmp=$(mktemp) || exit 1
  awk -v b="$MARK_BEGIN" -v e="$MARK_END" \
    '($0==b){skip=1} (!skip){print} ($0==e){skip=0}' "$ZPROFILE" > "$tmp" || { rm -f "$tmp"; exit 1; }
  chmod 0644 "$tmp"
  chown root:wheel "$tmp"
  mv "$tmp" "$ZPROFILE"
  echo "removed managed block from $ZPROFILE"
fi

if [[ -d "$STATE_DIR" ]]; then
  rm -rf "$STATE_DIR"
  echo "removed $STATE_DIR"
fi

echo "mantis terminal canary uninstalled"
exit 0
