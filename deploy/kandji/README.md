# Kandji fleet deployment — terminal-open canaries

Give every Mac in your Kandji tenant its own Mantis canary key, and get
notified the moment anyone opens an interactive terminal on a machine where
they shouldn't be. Each machine's key is unique (`external_id` = its serial
number), so an alert tells you exactly which device tripped, and disabling
one machine's canary never touches the rest of the fleet.

```
Kandji blueprint ──▸ mantis-terminal-canary.zsh (runs as root, daily)
                       │  POST /api/keys {external_id: <serial>}   ← enroll-scoped key
                       ▼
                    Mantis mints (or returns) the machine's unique key
                       │
                       ▼
                    /etc/zprofile managed block + snippet installed
                       │
   user opens Terminal / iTerm / SSHs in (interactive login shell)
                       ▼
                    trigger URL pinged → IT notified (slack/email/webhook)
```

## Where alerts go

**Recommended: global destinations.** An admin sets them once in the dashboard
(Settings → notifications). They receive alerts from every key, including
every key a device enrolls, so nothing about your alert channel has to ship to
the fleet and no device-side script can change it.

Per-key destinations are optional extras on top of that:

- [preprovision.sh](preprovision.sh) can attach `NOTIFY_CHANNEL` /
  `NOTIFY_TARGET` when it creates a key with your full-scope key (Option B).
- [mantis-terminal-canary.zsh](mantis-terminal-canary.zsh) can send
  `MANTIS_NOTIFY_CHANNEL` / `MANTIS_NOTIFY_TARGET` at first enrollment, but
  **only if the operator has pre-approved that exact pair on the server.** Add
  it to the `MANTIS_ENROLL_DESTINATIONS` environment variable — whitespace-
  separated `channel:target` pairs — and restart Mantis:

  ```bash
  MANTIS_ENROLL_DESTINATIONS="slack:https://hooks.slack.com/services/T000/B000/XXXX"
  ```

  A destination an enroll key sends that is not on that list is refused with
  `403` and the device script exits non-zero.

Do not rely on a per-key destination alone. A destination is attached only
when a key is first created, and a claim never changes an existing key — so a
key that already exists for a serial (see the next section) keeps whatever
routing it was created with. With a global destination every key alerts you
regardless.

## Why an *enrollment-scoped* API key

The script embeds an API key on every managed Mac, so assume a curious user
will extract it. Mint the key with `"scope": "enroll"`:

```bash
curl -sS -X POST "$MANTIS_BASE_URL/api/api-keys" \
  -H "Authorization: Bearer <ADMIN KEY>" \
  -H "Content-Type: application/json" \
  -d '{"name":"kandji-enroll","scope":"enroll"}'
```

An enroll key can call `POST /api/keys` and nothing else, and only to ask for
a plain tripwire. It may send exactly these fields:

| Field | Allowed from an enroll key |
|---|---|
| `memo` | yes |
| `external_id` | yes |
| `response_kind` | `gif` or `empty` only |
| `dedupe_window_seconds` | up to `600` |
| `destinations` | only pairs listed in `MANTIS_ENROLL_DESTINATIONS` |
| anything else (`expires_at`, monitor settings, response payloads, …) | refused — `403` |

Someone who lifts the key from a device **cannot** list the fleet's canaries,
read hit history or alert destinations, disable or delete keys, mint other API
keys, or log in to the dashboard. They also cannot give a key an expiry, or
point its alerts anywhere you have not approved.

What they *can* do:

- create noise keys;
- walk serials they know to recover those machines' trigger URLs, and fire
  them — false alarms. These claims are audited (below);
- enroll a serial **before** the real machine does. The machine then adopts
  that key. It is still a live tripwire with no expiry — its hits are recorded
  and go to your global destinations — but its memo text and dedupe window (at
  most 10 minutes) are the attacker's, and the destination the real machine
  would have attached is not added to it. This is the reason to use global
  destinations, and to pre-provision (Option B) where you can: a serial your
  own key has already claimed cannot be squatted.

Revoke and re-issue the enroll key at any time; existing canaries and their
alerts are unaffected.

`POST /api/keys` with an `external_id` is idempotent: the first call creates
the key, every later call (Kandji re-runs, reimaged machines) returns the
same key — status `200` with `"reused": true` instead of `201`, plus
`"created_by_caller"` saying whether the API key making the claim is the one
that created it. A claim never changes the memo or destinations already on
the key, and enroll-scoped callers get a reduced response (trigger URL and
identity only, no alert routing, no signing secrets; `memo` is `null` when
the enroll key is not the one that created the key). Such cross-key claims
are audited as `key.claimed` with `cross_key: true` — that trail is how you
spot an extracted enroll key walking serials. A full-scope key that did not
create the key gets `409` instead, so re-run [preprovision.sh](preprovision.sh)
with the same key (or an admin key).

A key that is **disabled or expired is never handed out**: claiming its
`external_id` returns `409`, for every caller. The machine's script then fails
visibly instead of installing a tripwire that cannot fire.

## Option A — self-enrolling (simplest)

Every device creates its own key on first run.

1. Set a global notification destination in the dashboard (see
   [Where alerts go](#where-alerts-go)).
2. Mint an enroll-scoped key (above).
3. Edit the `CONFIGURE` block in [mantis-terminal-canary.zsh](mantis-terminal-canary.zsh):
   `MANTIS_BASE_URL` and `MANTIS_ENROLL_KEY`. Leave `MANTIS_NOTIFY_*` empty
   unless you have added that pair to `MANTIS_ENROLL_DESTINATIONS`; anything
   you put there ships to every device and is readable by device admins.
4. Kandji → **Library → Custom Scripts → New**: paste the script as the
   Audit Script, set execution frequency (daily is fine — the script
   self-heals), assign the blueprint. No remediation script needed.
5. Watch keys appear as machines check in (`mantis watch`, or the dashboard).

## Option B — pre-provision centrally, devices claim

Keys are created from your workstation before devices ask for them, so a
serial that has been pre-provisioned cannot be enrolled by anyone else first.

1. From an admin workstation, run [preprovision.sh](preprovision.sh) with a
   **full**-scope key. It pages your Kandji device inventory and creates one
   key per Mac (memo = device name, `external_id` = serial, plus your
   `NOTIFY_CHANNEL`/`NOTIFY_TARGET` if you set them), writing a CSV of trigger
   URLs. Re-run it whenever; it's idempotent and picks up new devices.
2. Deploy `mantis-terminal-canary.zsh` via Kandji as in Option A, leaving
   `MANTIS_NOTIFY_*` empty. Each device claims its pre-made key by serial and
   just receives its trigger URL.

`preprovision.sh` exits non-zero when any device could not be provisioned, and
prints one `FAILED <serial> (<name>): …` line per device saying why. Device
names come from the Macs themselves, so the script strips control characters
from them before printing, and prefixes spreadsheet-formula starts
(`=`, `+`, `-`, `@`) with `'` in the CSV.

Both options need managed devices to reach `MANTIS_BASE_URL` over HTTPS
(public hostname, tunnel, or tailnet).

## When enrollment is refused

Both scripts stop and say so; neither installs or records a key the server did
not return as live. The device script exits `2`, which Kandji shows as a
failing library item.

| What happened | Meaning | Fix |
|---|---|---|
| `403` | The request contained something this API key may not send. For an enroll key: a field outside the table above, a dedupe window over 600 s, or a destination that is not in `MANTIS_ENROLL_DESTINATIONS`. | Empty `MANTIS_NOTIFY_*` (or pre-approve the pair on the server); keep `MANTIS_DEDUPE_SECONDS` ≤ 600. For `preprovision.sh`, use a full-scope key. |
| `409` | The serial already has a key that will not be handed out: it is disabled or expired, or (full-scope keys only) another API key created it. | Re-enable or delete that key in the dashboard; or re-run `preprovision.sh` with the key that created it, or an admin key. |
| `422` | The request was invalid (for example a memo over 500 characters, or an `expires_at` in the past). | Check the values in the script's `CONFIGURE` block. |
| Key returned with `"disabled": true` or a non-null `"expires_at"` | The key cannot fire, or will stop firing. | Clear the expiry / re-enable, or delete the key so the next run creates a fresh one. |
| `preprovision.sh`: "created by a different API key" | The key existed already (for example the device self-enrolled first), so this run did not apply its memo, dedupe window or `NOTIFY_*`. A warning; a failure only when `NOTIFY_*` was requested. | Check the key's destinations in the dashboard, or rely on global destinations. |

## What fires — and what doesn't

The installed snippet is sourced from `/etc/zprofile` and pings the trigger
URL only for **interactive login shells attached to a TTY**:

- Fires: Terminal.app, iTerm2, Warp, kitty, VS Code's integrated terminal
  (macOS default profiles start login shells), inbound interactive SSH,
  new tmux panes.
- Doesn't fire: the Kandji agent, MDM/background scripts, cron, build tools,
  `zsh script.sh`, any non-interactive shell.

Bursts collapse server-side via `dedupe_window_seconds` (default here 120s —
tune in the script, up to 600). Users who switched their login shell to bash
bypass `/etc/zprofile`; if that matters, add the same managed block to
`/etc/profile`.

Each hit carries headers you can filter on in your alert pipeline:
`X-Mantis-User`, `X-Mantis-Host`, `X-Mantis-Term-Program` (e.g.
`Apple_Terminal`, `iTerm.app`, `vscode`), `X-Mantis-SSH-Connection` (set for
SSH sessions), `X-Mantis-TTY`.

## Honest limitations

This is a tripwire, not tamper-proof endpoint security. The trigger URL must
be readable by user shells, so a user can see it (worst case: false alarms).
A **local admin** can remove the snippet or the `/etc/zprofile` block —
the daily Kandji run reinstalls it and the script exits non-zero if it can't,
which surfaces in Kandji as a failing library item. Silence between check-ins
is possible; treat missing daily "healthy" runs as a signal.

The device script checks that its key is live when it enrolls, not on every
run. If you later disable, expire or delete a machine's key on the server, the
machine keeps pinging a URL that no longer alerts and still reports healthy.

## Verify, uninstall, rotate

- **Verify on a test Mac:** run the library item once (Kandji → device →
  Reinstall), then open Terminal — the hit should appear within seconds
  (`mantis hits <id>` or the dashboard), and the alert should arrive at your
  destination.
- **Updating from an earlier version of the script:** machines that enrolled
  before the script checked key liveness are re-checked once, automatically,
  on their next run (one extra claim per machine). A machine whose key turns
  out to be disabled or expired starts failing in Kandji — fix the key as in
  the table above. To force a re-check later, delete
  `/Library/Application Support/Mantis/enroll-verified` on the machine.
- **Uninstall:** deploy [uninstall-terminal-canary.zsh](uninstall-terminal-canary.zsh)
  (removes the `/etc/zprofile` block and state dir), then disable or delete
  the machine's key server-side.
- **Rotate the enroll key:** revoke it (`DELETE /api/api-keys/<id>`), mint a
  new one, update the script in Kandji. Enrolled machines keep working — the
  key is only used to (re)claim a trigger URL, and re-claims with the new
  key still resolve to the same `external_id`.
