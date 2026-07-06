#!/bin/zsh
# =============================================================================
# Mantis terminal-open canary — Kandji Custom Script (audit + self-remediate)
#
# Deployed to every Mac in a blueprint. On each run it:
#   1. Enrolls the machine once: POST /api/keys with external_id=<serial>,
#      which mints a unique canary key per machine (idempotent — re-runs and
#      reimages return the existing key instead of creating duplicates).
#   2. Installs /Library/Application Support/Mantis/terminal-canary.sh and a
#      managed block in /etc/zprofile that pings the machine's trigger URL
#      whenever an INTERACTIVE login shell starts (Terminal.app, iTerm, SSH).
#      Background agents, Kandji scripts, and non-interactive shells never fire.
#
# Use an ENROLLMENT-SCOPED Mantis API key here, never a full/admin key. An
# enroll key can only create canary keys — if a user extracts it from this
# script they cannot list, read, disable, or delete the fleet's canaries,
# read hit history, or log in to the dashboard. Mint one with:
#
#   curl -sS -X POST "$MANTIS_BASE_URL/api/api-keys" \
#     -H "Authorization: Bearer <ADMIN KEY>" -H "Content-Type: application/json" \
#     -d '{"name":"kandji-enroll","scope":"enroll"}'
#
# Kandji setup: Library → Custom Scripts → New. Paste this file as the Audit
# Script, set execution frequency to daily (or every 15 minutes), assign to
# your Mac blueprint. The script is idempotent and self-heals tampering.
#
# Exit codes: 0 installed/healthy · 1 config error · 2 enrollment failed ·
#             3 install failed
# =============================================================================

set -u

# ─── CONFIGURE ───────────────────────────────────────────────────────────────
MANTIS_BASE_URL="https://mantis.example.com"   # no trailing slash
MANTIS_ENROLL_KEY="mantis_live_REPLACE_ME"     # enrollment-scoped key ONLY

# Optional: attach notification destinations at first enrollment. Leave both
# empty if you pre-provision keys centrally (see preprovision.sh) or attach
# destinations from the dashboard — anything set here ships to every device.
MANTIS_NOTIFY_CHANNEL=""                       # webhook|slack|discord|teams|email
MANTIS_NOTIFY_TARGET=""                        # URL for webhook-shaped channels, address for email

# Seconds during which repeat opens collapse into one alert (tmux bursts etc.).
MANTIS_DEDUPE_SECONDS=120
# ─────────────────────────────────────────────────────────────────────────────

STATE_DIR="/Library/Application Support/Mantis"
URL_FILE="$STATE_DIR/trigger-url"
SNIPPET="$STATE_DIR/terminal-canary.sh"
ZPROFILE="/etc/zprofile"
MARK_BEGIN="# BEGIN MANTIS TERMINAL CANARY (managed — do not edit)"
MARK_END="# END MANTIS TERMINAL CANARY"

if [[ $EUID -ne 0 ]]; then
  echo "must run as root (Kandji runs custom scripts as root)" >&2
  exit 1
fi
if [[ "$MANTIS_ENROLL_KEY" == *REPLACE_ME* || -z "$MANTIS_BASE_URL" ]]; then
  echo "MANTIS_BASE_URL / MANTIS_ENROLL_KEY not configured" >&2
  exit 1
fi

json_escape() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }

serial=$(ioreg -rd1 -c IOPlatformExpertDevice | awk -F'"' '/IOPlatformSerialNumber/{print $4}')
if [[ -z "${serial:-}" ]]; then
  echo "could not read platform serial number" >&2
  exit 2
fi
computer_name=$(scutil --get ComputerName 2>/dev/null || hostname)

# ─── 1. Enroll (once) ────────────────────────────────────────────────────────
trigger_url=""
if [[ -s "$URL_FILE" ]]; then
  trigger_url=$(head -n1 "$URL_FILE")
fi

if [[ "$trigger_url" != http* ]]; then
  memo="Terminal opened — $(json_escape "$computer_name") (${serial})"
  body="{\"memo\":\"${memo}\",\"external_id\":\"${serial}\",\"response_kind\":\"empty\",\"dedupe_window_seconds\":${MANTIS_DEDUPE_SECONDS}"
  if [[ -n "$MANTIS_NOTIFY_CHANNEL" && -n "$MANTIS_NOTIFY_TARGET" ]]; then
    body+=",\"destinations\":[{\"channel\":\"${MANTIS_NOTIFY_CHANNEL}\",\"target\":\"$(json_escape "$MANTIS_NOTIFY_TARGET")\"}]"
  fi
  body+="}"

  response=$(curl -sS -m 20 -w $'\n%{http_code}' \
    -X POST "$MANTIS_BASE_URL/api/keys" \
    -H "Authorization: Bearer $MANTIS_ENROLL_KEY" \
    -H "Content-Type: application/json" \
    -d "$body" 2>/dev/null)
  http_code=${response##*$'\n'}
  payload=${response%$'\n'*}

  if [[ "$http_code" != "200" && "$http_code" != "201" ]]; then
    echo "enrollment failed (HTTP ${http_code:-none}): ${payload:-no response}" >&2
    exit 2
  fi

  trigger_url=$(printf '%s' "$payload" | plutil -extract url raw -o - -- - 2>/dev/null) ||
    trigger_url=$(printf '%s' "$payload" | sed -n 's/.*"url":"\([^"]*\)".*/\1/p')
  if [[ "$trigger_url" != http* ]]; then
    echo "enrollment response had no trigger URL: $payload" >&2
    exit 2
  fi

  install -d -m 0755 -o root -g wheel "$STATE_DIR"
  printf '%s\n' "$trigger_url" > "$URL_FILE"
  chmod 0644 "$URL_FILE"
  chown root:wheel "$URL_FILE"
  echo "enrolled ${serial} (HTTP $http_code)"
fi

# ─── 2. Install the tripwire snippet (always rewritten to current version) ───
install -d -m 0755 -o root -g wheel "$STATE_DIR"
cat > "$SNIPPET" <<'EOSNIPPET'
# Mantis terminal-open canary (managed by IT via Kandji).
# Notifies IT when an interactive terminal session starts on this machine.
# Sourced from /etc/zprofile for login shells; fires only when the shell is
# interactive and attached to a TTY, so background agents and scripts never
# trigger it. Backgrounded with a 3s timeout — it cannot block your shell.
case "$-" in
  *i*)
    if [ -t 0 ] && [ -r "/Library/Application Support/Mantis/trigger-url" ]; then
      _mantis_url=$(head -n1 "/Library/Application Support/Mantis/trigger-url" 2>/dev/null)
      case "$_mantis_url" in
        http*)
          # tty/hostname are captured HERE, in the foreground shell — inside
          # the backgrounded subshell stdin is already /dev/null and tty(1)
          # would return "not a tty".
          _mantis_tty=$(tty 2>/dev/null) || _mantis_tty=unknown
          _mantis_host=$(hostname 2>/dev/null) || _mantis_host=unknown
          (curl -fsS -m 3 -o /dev/null \
            -H "X-Mantis-Source: kandji-terminal" \
            -H "X-Mantis-User: ${USER:-unknown}" \
            -H "X-Mantis-Host: ${_mantis_host}" \
            -H "X-Mantis-Term-Program: ${TERM_PROGRAM:-}${TERM_PROGRAM_VERSION:+ }${TERM_PROGRAM_VERSION:-}" \
            -H "X-Mantis-SSH-Connection: ${SSH_CONNECTION:-}" \
            -H "X-Mantis-TTY: ${_mantis_tty}" \
            "$_mantis_url" >/dev/null 2>&1 &) 2>/dev/null
          unset _mantis_tty _mantis_host
          ;;
      esac
      unset _mantis_url
    fi
    ;;
esac
EOSNIPPET
chmod 0644 "$SNIPPET"
chown root:wheel "$SNIPPET"

# ─── 3. Ensure the managed block in /etc/zprofile ────────────────────────────
source_line='[ -f "/Library/Application Support/Mantis/terminal-canary.sh" ] && . "/Library/Application Support/Mantis/terminal-canary.sh"'

needs_block=1
if [[ -f "$ZPROFILE" ]] &&
   grep -qxF "$MARK_BEGIN" "$ZPROFILE" &&
   grep -qxF "$source_line" "$ZPROFILE"; then
  needs_block=0
fi

if (( needs_block )); then
  tmp=$(mktemp) || exit 3
  if [[ -f "$ZPROFILE" ]]; then
    # Strip any previous managed block, then re-append the current one.
    awk -v b="$MARK_BEGIN" -v e="$MARK_END" \
      '($0==b){skip=1} (!skip){print} ($0==e){skip=0}' "$ZPROFILE" > "$tmp" || { rm -f "$tmp"; exit 3; }
  fi
  {
    printf '\n%s\n' "$MARK_BEGIN"
    printf '%s\n' "$source_line"
    printf '%s\n' "$MARK_END"
  } >> "$tmp"
  chmod 0644 "$tmp"
  chown root:wheel "$tmp"
  mv "$tmp" "$ZPROFILE" || { rm -f "$tmp"; exit 3; }
  echo "installed managed block in $ZPROFILE"
fi

echo "mantis terminal canary healthy — serial ${serial}"
exit 0
