#!/usr/bin/env bash
# =============================================================================
# Pre-provision one Mantis canary key per Mac in your Kandji tenant.
#
# Run this from an admin workstation (NOT on managed devices) with a FULL
# Mantis API key. It pages through Kandji's device inventory and creates one
# key per machine — memo carries the device name, external_id carries the
# serial — attaching your notification destination server-side so the webhook
# / email target never ships to the fleet.
#
# Idempotent: external_id makes re-runs claim existing keys (reused=true), so
# schedule it to pick up newly enrolled devices. Devices later claim their own
# trigger URL by serial via mantis-terminal-canary.zsh with an enroll-scoped
# key (leave MANTIS_NOTIFY_* empty there).
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

echo "serial,device_name,key_id,trigger_url,reused" > "$OUT_CSV"

limit=300
offset=0
total=0
while :; do
  page=$(curl -fsS -m 60 \
    -H "Authorization: Bearer $KANDJI_API_TOKEN" \
    "$KANDJI_API_URL/api/v1/devices?platform=Mac&limit=$limit&offset=$offset")

  count=$(jq 'length' <<<"$page")
  [ "$count" -eq 0 ] && break

  while IFS=$'\t' read -r serial name; do
    [ -n "$serial" ] || continue

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
      -d "$body" </dev/null)
    code=${resp##*$'\n'}
    payload=${resp%$'\n'*}

    if [ "$code" != "200" ] && [ "$code" != "201" ]; then
      echo "FAILED $serial ($name): HTTP $code $payload" >&2
      continue
    fi

    jq -r --arg serial "$serial" --arg name "$name" \
      '[$serial, $name, .id, .url, (.reused|tostring)] | @csv' \
      <<<"$payload" >> "$OUT_CSV"
    total=$((total + 1))
    echo "$serial → $(jq -r '.url' <<<"$payload") (reused=$(jq -r '.reused' <<<"$payload"))"
  done < <(jq -r '.[] | [.serial_number // empty, .device_name // "unnamed"] | @tsv' <<<"$page")

  [ "$count" -lt "$limit" ] && break
  offset=$((offset + limit))
done

echo
echo "provisioned/verified $total device keys → $OUT_CSV"
