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
# The server only lets an enroll key set memo, external_id, response_kind
# (gif|empty) and a dedupe window of at most 600 s — which is all this script
# sends. Alert routing is decided on the server (see CONFIGURE below).
#
# Kandji setup: Library → Custom Scripts → New. Paste this file as the Audit
# Script, set execution frequency to daily (or every 15 minutes), assign to
# your Mac blueprint. The script is idempotent and self-heals tampering.
#
# Exit codes: 0 installed/healthy · 1 config error · 2 enrollment failed
#             (includes: server refused the request with 403/409/422, or
#             returned a key that is disabled or has an expiry — such a key is
#             never installed) · 3 install failed
# =============================================================================

set -u

# ─── CONFIGURE ───────────────────────────────────────────────────────────────
MANTIS_BASE_URL="https://mantis.example.com"   # no trailing slash
MANTIS_ENROLL_KEY="mantis_live_REPLACE_ME"     # enrollment-scoped key ONLY

# Alert routing. RECOMMENDED: leave both empty and have an admin configure
# GLOBAL notification destinations on the server (dashboard → Settings →
# notifications). Every fleet key then alerts there, and nothing about your
# alert channel ships to devices.
#
# Only set these if this fleet needs its own destination, and FIRST add the
# exact pair to MANTIS_ENROLL_DESTINATIONS in the server's environment
# (whitespace-separated channel:target pairs, e.g.
# MANTIS_ENROLL_DESTINATIONS="slack:https://hooks.slack.com/services/T000/B000/XXXX").
# The server rejects (HTTP 403) any destination an enroll key sends that is
# not pre-approved there, and this script then exits 2. Anything set here is
# readable on every device, and applies only when a key is first created.
MANTIS_NOTIFY_CHANNEL=""                       # webhook|slack|discord|teams|email
MANTIS_NOTIFY_TARGET=""                        # URL for webhook-shaped channels, address for email

# Seconds during which repeat opens collapse into one alert (tmux bursts etc.).
# The server accepts at most 600 from an enroll key.
MANTIS_DEDUPE_SECONDS=120
# ─────────────────────────────────────────────────────────────────────────────

STATE_DIR="/Library/Application Support/Mantis"
URL_FILE="$STATE_DIR/trigger-url"
# Written once the server has confirmed this machine's key is live. Installs
# made by an earlier version of this script have no marker and are re-checked.
VERIFIED_FILE="$STATE_DIR/enroll-verified"
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
if [[ "$MANTIS_DEDUPE_SECONDS" != <0-600> ]]; then
  echo "MANTIS_DEDUPE_SECONDS must be a whole number from 0 to 600 (the most the server accepts from an enroll key)" >&2
  exit 1
fi

json_escape() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }

# True when an enrollment response describes a key that can fire: it must say
# both "disabled":false and "expires_at":null. A disabled or expiring key
# answers the trigger URL but records nothing, so installing one would report
# this machine healthy while its tripwire is dead. Anything that does not
# state both facts is refused (fail closed). A quote inside a JSON string
# value is always written \" by the server, so text in the memo cannot
# satisfy either pattern.
key_is_live() {
  printf '%s' "$1" | grep -Eq '"disabled"[[:space:]]*:[[:space:]]*false' &&
    printf '%s' "$1" | grep -Eq '"expires_at"[[:space:]]*:[[:space:]]*null'
}

serial=$(ioreg -rd1 -c IOPlatformExpertDevice | awk -F'"' '/IOPlatformSerialNumber/{print $4}')
if [[ -z "${serial:-}" ]]; then
  echo "could not read platform serial number" >&2
  exit 2
fi
computer_name=$(scutil --get ComputerName 2>/dev/null || hostname)
# The name goes into a JSON string, where raw control characters are invalid.
computer_name=$(printf '%s' "$computer_name" | LC_ALL=C tr -d '\000-\037\177')

# ─── 1. Enroll (once) ────────────────────────────────────────────────────────
trigger_url=""
if [[ -s "$URL_FILE" ]]; then
  trigger_url=$(head -n1 "$URL_FILE")
fi

# An install made before this script checked key liveness has a trigger URL
# but no marker. Claim the key again, once (the claim is idempotent), so a
# disabled or expiring key surfaces here instead of staying silently dead.
reverify=0
if [[ "$trigger_url" == http* && ! -f "$VERIFIED_FILE" ]]; then
  reverify=1
fi

if [[ "$trigger_url" != http* || $reverify -eq 1 ]]; then
  # Only the fields an enroll key is allowed to set — see the header.
  memo="Terminal opened — $(json_escape "$computer_name") (${serial})"
  body="{\"memo\":\"${memo}\",\"external_id\":\"${serial}\",\"response_kind\":\"empty\",\"dedupe_window_seconds\":${MANTIS_DEDUPE_SECONDS}"
  if [[ -n "$MANTIS_NOTIFY_CHANNEL" && -n "$MANTIS_NOTIFY_TARGET" ]]; then
    body+=",\"destinations\":[{\"channel\":\"$(json_escape "$MANTIS_NOTIFY_CHANNEL")\",\"target\":\"$(json_escape "$MANTIS_NOTIFY_TARGET")\"}]"
  fi
  body+="}"

  response=$(curl -sS -m 20 -w $'\n%{http_code}' \
    -X POST "$MANTIS_BASE_URL/api/keys" \
    -H "Authorization: Bearer $MANTIS_ENROLL_KEY" \
    -H "Content-Type: application/json" \
    -d "$body" 2>/dev/null)
  http_code=${response##*$'\n'}
  payload=${response%$'\n'*}
  detail=${${payload:-no response}[1,400]}

  if (( reverify )) && [[ -z "$http_code" || "$http_code" == (000|429|5??) ]]; then
    # The server could not answer right now. The installed tripwire keeps
    # working; try the check again on the next run.
    echo "could not re-verify enrollment (HTTP ${http_code:-none}) — keeping the installed trigger URL, will retry next run" >&2
  else
    case "$http_code" in
      200|201) ;;
      403)
        echo "enrollment refused (HTTP 403): an enroll key may only set memo, external_id, response_kind and a dedupe window of at most 600 s." >&2
        if [[ -n "$MANTIS_NOTIFY_CHANNEL" && -n "$MANTIS_NOTIFY_TARGET" ]]; then
          echo "MANTIS_NOTIFY_CHANNEL/MANTIS_NOTIFY_TARGET is set: that exact channel:target pair must first be added to MANTIS_ENROLL_DESTINATIONS on the Mantis server — or leave both empty and use global destinations." >&2
        fi
        echo "server said: $detail" >&2
        exit 2
        ;;
      409)
        echo "enrollment refused (HTTP 409): serial ${serial} already has a key on the Mantis server that cannot be handed out — normally because it is disabled or expired. An admin must re-enable or delete that key; this machine has no working tripwire until then." >&2
        echo "server said: $detail" >&2
        exit 2
        ;;
      422)
        echo "enrollment rejected as invalid (HTTP 422) — check MANTIS_DEDUPE_SECONDS and MANTIS_NOTIFY_* in this script." >&2
        echo "server said: $detail" >&2
        exit 2
        ;;
      *)
        echo "enrollment failed (HTTP ${http_code:-none}): $detail" >&2
        exit 2
        ;;
    esac

    if ! key_is_live "$payload"; then
      echo "enrollment returned a key for serial ${serial} that is disabled or has an expiry — refusing to install it (it would never alert). An admin must re-enable, clear the expiry on, or delete that key on the Mantis server." >&2
      echo "server said: $detail" >&2
      exit 2
    fi

    trigger_url=$(printf '%s' "$payload" | plutil -extract url raw -o - -- - 2>/dev/null) ||
      trigger_url=$(printf '%s' "$payload" | sed -n 's/.*"url":"\([^"]*\)".*/\1/p')
    if [[ "$trigger_url" != http* ]]; then
      echo "enrollment response had no trigger URL: $detail" >&2
      exit 2
    fi

    install -d -m 0755 -o root -g wheel "$STATE_DIR"
    printf '%s\n' "$trigger_url" > "$URL_FILE"
    chmod 0644 "$URL_FILE"
    chown root:wheel "$URL_FILE"
    printf 'verified\n' > "$VERIFIED_FILE"
    chmod 0644 "$VERIFIED_FILE"
    chown root:wheel "$VERIFIED_FILE"
    if (( reverify )); then
      echo "re-verified ${serial} (HTTP $http_code)"
    else
      echo "enrolled ${serial} (HTTP $http_code)"
    fi
  fi
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
