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

## Why an *enrollment-scoped* API key

The script embeds an API key on every managed Mac, so assume a curious user
will extract it. Mint the key with `"scope": "enroll"`:

```bash
curl -sS -X POST "$MANTIS_BASE_URL/api/api-keys" \
  -H "Authorization: Bearer <ADMIN KEY>" \
  -H "Content-Type: application/json" \
  -d '{"name":"kandji-enroll","scope":"enroll"}'
```

An enroll key can call `POST /api/keys` and nothing else. Someone who lifts
it from a device **cannot** list the fleet's canaries, read hit history or
alert destinations, disable or delete keys, mint other API keys, or log in
to the dashboard. Worst case they can create noise keys or re-claim a
trigger URL for a serial they already know — i.e. cause false alarms, never
silence. Revoke and re-issue the enroll key at any time; existing canaries
and their alerts are unaffected.

`POST /api/keys` with an `external_id` is idempotent: the first call creates
the key, every later call (Kandji re-runs, reimaged machines) returns the
same key — status `200` with `"reused": true` instead of `201`. A claim
never changes the memo or destinations IT configured, and enroll-scoped
callers get a reduced response (trigger URL and identity only, no alert
routing, no signing secrets).

## Option A — self-enrolling (simplest)

Every device creates its own key on first run.

1. Mint an enroll-scoped key (above).
2. Edit the `CONFIGURE` block in [mantis-terminal-canary.zsh](mantis-terminal-canary.zsh):
   `MANTIS_BASE_URL`, `MANTIS_ENROLL_KEY`, and optionally
   `MANTIS_NOTIFY_CHANNEL` / `MANTIS_NOTIFY_TARGET` so alerts are attached at
   enrollment. Anything you put here ships to every device — a Slack webhook
   URL in the script is readable by device admins. If that bothers you, use
   Option B and leave the notify fields empty.
3. Kandji → **Library → Custom Scripts → New**: paste the script as the
   Audit Script, set execution frequency (daily is fine — the script
   self-heals), assign the blueprint. No remediation script needed.
4. Watch keys appear as machines check in (`mantis watch`, or the dashboard).

## Option B — pre-provision centrally, devices claim

Alert destinations are configured server-side and never ship to devices.

1. From an admin workstation, run [preprovision.sh](preprovision.sh) with a
   **full**-scope key. It pages your Kandji device inventory and creates one
   key per Mac (memo = device name, `external_id` = serial, your
   `NOTIFY_CHANNEL`/`NOTIFY_TARGET` attached), writing a CSV of trigger URLs.
   Re-run it whenever; it's idempotent and picks up new devices.
2. Deploy `mantis-terminal-canary.zsh` via Kandji as in Option A, but leave
   `MANTIS_NOTIFY_*` empty. Each device claims its pre-made key by serial and
   just receives its trigger URL.

Both options need managed devices to reach `MANTIS_BASE_URL` over HTTPS
(public hostname, tunnel, or tailnet).

## What fires — and what doesn't

The installed snippet is sourced from `/etc/zprofile` and pings the trigger
URL only for **interactive login shells attached to a TTY**:

- Fires: Terminal.app, iTerm2, Warp, kitty, VS Code's integrated terminal
  (macOS default profiles start login shells), inbound interactive SSH,
  new tmux panes.
- Doesn't fire: the Kandji agent, MDM/background scripts, cron, build tools,
  `zsh script.sh`, any non-interactive shell.

Bursts collapse server-side via `dedupe_window_seconds` (default here 120s —
tune in the script). Users who switched their login shell to bash bypass
`/etc/zprofile`; if that matters, add the same managed block to
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

## Verify, uninstall, rotate

- **Verify on a test Mac:** run the library item once (Kandji → device →
  Reinstall), then open Terminal — the hit should appear within seconds
  (`mantis hits <id>` or the dashboard).
- **Uninstall:** deploy [uninstall-terminal-canary.zsh](uninstall-terminal-canary.zsh)
  (removes the `/etc/zprofile` block and state dir), then disable or delete
  the machine's key server-side.
- **Rotate the enroll key:** revoke it (`DELETE /api/api-keys/<id>`), mint a
  new one, update the script in Kandji. Enrolled machines keep working — the
  key is only used to (re)claim a trigger URL, and re-claims with the new
  key still resolve to the same `external_id`.
