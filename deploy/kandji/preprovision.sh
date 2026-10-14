#!/usr/bin/env bash
# =============================================================================
# Pre-provision one Mantis canary key per Mac in your Kandji tenant.
#
# Run this from an admin workstation (NOT on managed devices) with a FULL
# Mantis API key. It pages through Kandji's device inventory and creates one
# key per machine — memo carries the device name, external_id carries the
# serial.
#
# Alert routing: the recommended setup is GLOBAL notification destinations,
# configured once by an admin in the dashboard (Settings → notifications).
# Every key alerts there, so leave NOTIFY_* unset. Set NOTIFY_CHANNEL /
# NOTIFY_TARGET only if these keys need their own destination; it is attached
# server-side when a key is first created, so the webhook / email target never
# ships to the fleet.
#
# Idempotent: external_id makes re-runs claim existing keys (reused=true), so
# schedule it to pick up newly enrolled devices. Devices later claim their own
# trigger URL by serial via mantis-terminal-canary.zsh with an enroll-scoped
# key (leave MANTIS_NOTIFY_* empty there).
#
# A key is only written to the CSV when the server returns it as live. The run
# exits non-zero, after processing every device, if any device was refused:
#   - HTTP 403/409/422 from the server (see the message printed per device);
#   - the returned key is disabled or has an expiry (it would never fire, or
#     stop firing, while looking provisioned);
#   - NOTIFY_* was requested but the key already existed and was created by a
#     different API key, so this run did not attach your destination.
#
# Requires: curl, jq.
#
# Environment:
#   KANDJI_API_URL      e.g. https://yourtenant.api.kandji.io
#   KANDJI_API_TOKEN    Kandji API token with Device list permission
#   MANTIS_BASE_URL     e.g. https://mantis.example.com
#   MANTIS_API_KEY      FULL-scope Mantis key (admin not required)
#   NOTIFY_CHANNEL      optional: webhook|slack|discord|teams|email
#   NOTIFY_TARGET       optional: destination URL / email address
#   OUT_CSV             optional: output path (default ./mantis-kandji-keys.csv)
# =============================================================================
set -euo pipefail

: "${KANDJI_API_URL:?set KANDJI_API_URL}"
: "${KANDJI_API_TOKEN:?set KANDJI_API_TOKEN}"
: "${MANTIS_BASE_URL:?set MANTIS_BASE_URL}"
: "${MANTIS_API_KEY:?set MANTIS_API_KEY}"
NOTIFY_CHANNEL="${NOTIFY_CHANNEL:-}"
NOTIFY_TARGET="${NOTIFY_TARGET:-}"
OUT_CSV="${OUT_CSV:-./mantis-kandji-keys.csv}"

command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }

# The device name comes from Kandji inventory, which is fed by the managed Mac
# (a local admin can rename it), and it ends up on this terminal and in a CSV
# an admin opens in a spreadsheet. Treat it as untrusted text:
#   clean — drop C0/C1 control characters, DEL and the Unicode line/bidi
#           controls, so a name cannot carry terminal escape sequences or
#           break the tab/line framing below.
#   cell  — CSV formula guard, the same rule as the CLI's CSV writer
#           (cli/src/commands/bulk-create.ts): a cell starting with one of
#           = + - @ TAB CR is prefixed with an apostrophe (code point 39) so
#           spreadsheets show it as text.
# Written without regular expressions so any jq build can run them.
JQ_DEFS='
def clean:
  tostring | explode
  | map(select(. >= 32 and . != 127 and (. < 128 or . > 159)
               and . != 8232 and . != 8233
               and (. < 8234 or . > 8238) and (. < 8294 or . > 8297)))
  | implode;
def cell:
  tostring
  | .[0:1] as $c
  | if ($c == "=" or $c == "+" or $c == "-" or $c == "@" or $c == "\t" or $c == "\r")
    then ([39] | implode) + . else . end;
'

# Server text shown on the terminal. JSON is re-encoded ASCII-only (jq escapes
# every control and non-ASCII character); the result is then reduced to
# printable ASCII and truncated, so a response can neither drive the terminal
# nor flood the log.
printable() {
  local out
  out=$( { jq -ac . 2>/dev/null <<<"$1" || printf '%s' "$1"; } | LC_ALL=C tr -cd '\040-\176')
  printf '%s' "${out:0:300}"
}

echo "serial,device_name,key_id,trigger_url,reused" > "$OUT_CSV"

limit=300
offset=0
total=0
failed=0

fail() { # serial, name, reason
  failed=$((failed + 1))
  echo "FAILED $1 ($2): $3" >&2
}

while :; do
  page=$(curl -fsS -m 60 \
    -H "Authorization: Bearer $KANDJI_API_TOKEN" \
    "$KANDJI_API_URL/api/v1/devices?platform=Mac&limit=$limit&offset=$offset")

  count=$(jq 'length' <<<"$page")
  [ "$count" -eq 0 ] && break

  while IFS=$'\t' read -r serial name; do
    [ -n "$serial" ] || continue

    # Same charset the server enforces for external_id. Anything else would
    # only come back as a 422, so refuse it here with a clear message.
    if [[ ! "$serial" =~ ^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$ ]]; then
      fail "$serial" "$name" "serial is not a valid external_id (letters, digits, . _ : - only) — skipped"
      continue
    fi

    body=$(jq -n \
      --arg memo "Terminal opened — ${name} (${serial})" \
      --arg external_id "$serial" \
      --arg channel "$NOTIFY_CHANNEL" \
      --arg target "$NOTIFY_TARGET" \
      '{memo: $memo, external_id: $external_id, response_kind: "empty",
        dedupe_window_seconds: 120}
       + (if $channel != "" and $target != ""
          then {destinations: [{channel: $channel, target: $target}]}
          else {} end)')

    # </dev/null so curl can never eat the while-read loop's stdin.
    resp=$(curl -sS -m 30 -w $'\n%{http_code}' \
      -X POST "$MANTIS_BASE_URL/api/keys" \
      -H "Authorization: Bearer $MANTIS_API_KEY" \
      -H "Content-Type: application/json" \
      -d "$body" </dev/null) || true
    code=${resp##*$'\n'}
    payload=${resp%$'\n'*}

    case "$code" in
      200|201) ;;
      401)
        # Every remaining device would fail the same way.
        echo "MANTIS_API_KEY was rejected (HTTP 401): $(printable "$payload")" >&2
        exit 1
        ;;
      403)
        fail "$serial" "$name" "HTTP 403 — the server refused this request for this API key. Use a FULL-scope key here: an enroll-scoped key may only send memo, external_id, response_kind and a short dedupe window, and may attach NOTIFY_CHANNEL/NOTIFY_TARGET only when that exact pair is listed in MANTIS_ENROLL_DESTINATIONS on the server. $(printable "$payload")"
        continue
        ;;
      409)
        fail "$serial" "$name" "HTTP 409 — this serial is already claimed and the server will not hand the key out: either another API key created it (re-run with that key or an admin key), or the existing key is disabled or expired. Resolve it in the Mantis dashboard. $(printable "$payload")"
        continue
        ;;
      422)
        fail "$serial" "$name" "HTTP 422 — the server rejected the request as invalid. $(printable "$payload")"
        continue
        ;;
      *)
        fail "$serial" "$name" "HTTP ${code:-none} $(printable "$payload")"
        continue
        ;;
    esac

    # Never record a key that cannot fire as provisioned. The response must
    # say so explicitly: not disabled, no expiry, and a trigger URL.
    state=$(jq -r '
      if type != "object" then "unreadable"
      elif (.disabled == true) then "disabled"
      elif (has("expires_at") and .expires_at != null) then "expiring"
      elif (.disabled == false and has("expires_at")
            and ((.url // "") | tostring | startswith("http"))) then "live"
      else "unreadable" end' <<<"$payload" 2>/dev/null) || state="unreadable"
    case "$state" in
      live) ;;
      disabled)
        fail "$serial" "$name" "the server returned a DISABLED key — it will never fire. Re-enable or delete it in the Mantis dashboard, then re-run."
        continue
        ;;
      expiring)
        fail "$serial" "$name" "the server returned a key with an expiry (expires_at is set) — it will stop firing. Clear the expiry or delete the key in the Mantis dashboard, then re-run."
        continue
        ;;
      *)
        fail "$serial" "$name" "the response did not describe a live key (need disabled=false, expires_at=null and a trigger URL): $(printable "$payload")"
        continue
        ;;
    esac

    # A claim never changes an existing key. If another API key created it
    # (for example the device self-enrolled first), nothing this run asked
    # for — memo, dedupe window, NOTIFY_* — was applied to it.
    foreign=$(jq -r 'if (.reused == true and .created_by_caller == false) then "yes" else "no" end' <<<"$payload")
    if [ "$foreign" = "yes" ]; then
      if [ -n "$NOTIFY_CHANNEL" ] && [ -n "$NOTIFY_TARGET" ]; then
        fail "$serial" "$name" "the key already existed and was created by a different API key, so NOTIFY_CHANNEL/NOTIFY_TARGET was NOT attached. Check its destinations in the Mantis dashboard (or rely on global destinations)."
        continue
      fi
      echo "WARNING $serial ($name): key already existed and was created by a different API key; its memo and settings are that key's, not this run's." >&2
    fi

    jq -r "$JQ_DEFS"'
      [$serial, $name, .id, .url, (.reused | tostring)] | map(clean | cell) | @csv' \
      --arg serial "$serial" --arg name "$name" \
      <<<"$payload" >> "$OUT_CSV"
    total=$((total + 1))
    echo "$serial → $(jq -r "$JQ_DEFS"'.url | clean' <<<"$payload") (reused=$(jq -r '.reused // false' <<<"$payload"))"
  done < <(jq -r "$JQ_DEFS"'
    .[]
    | [ ((.serial_number // "") | clean),
        ((.device_name // "") | clean | .[0:128] | if . == "" then "unnamed" else . end) ]
    | select(.[0] != "")
    | join("\t")' <<<"$page")

  [ "$count" -lt "$limit" ] && break
  offset=$((offset + limit))
done

echo
echo "provisioned/verified $total device keys → $OUT_CSV"
if [ "$failed" -gt 0 ]; then
  echo "$failed device(s) were NOT provisioned — see the FAILED lines above." >&2
  exit 1
fi
