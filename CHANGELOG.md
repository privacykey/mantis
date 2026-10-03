# Changelog

Release notes for the Mantis server, CLI, edge worker and helpers. Newest first.

## 2026-10-03 — server 0.3.0 · CLI 0.3.0 · edge 0.2.0

Also bumped: `@mantis/core` 0.2.0, IoT helper 0.2.0.

A security release. It fixes the findings of an October 2026 audit: what a
fleet enrollment key can do, whether an alert reliably reaches the operator,
and whether generated canaries actually fire. Several fixes change behaviour;
read the upgrade checklist before deploying.

### Upgrade checklist

Server:

1. **Apply migration `0008_fleet_lineage_self_origins`** before or while
   starting the new server (`AUTO_MIGRATE=1`, or `pnpm db:migrate`). It adds
   `api_keys.owner_api_key_id` and `keys.self_origins`. Both are additive;
   nothing is rewritten or backfilled, and the previous server version keeps
   working against the migrated schema.
2. **Re-point Uptime Kuma (or other) monitors** at each key's new
   `monitor_status_url`. The status URL is now `/status/<publicId>.<tag>`;
   the old `/status/<publicId>` returns an empty 404. Rotating
   `MANTIS_API_KEY_PEPPER` changes every status URL.
3. **Fleet enrollment.** If devices attach their own alert destination when
   they enroll, list the approved pairs in `MANTIS_ENROLL_DESTINATIONS`
   (whitespace-separated `channel:target`). Otherwise such requests now get
   `403`. Routing fleet alerts with a global destination needs no setting.
4. **Split-host deployments:** check that dashboard links in alerts point at
   your dashboard host; set `DASHBOARD_BASE_URL` if the default is wrong.
5. **Client IPs:** when `TRUST_PROXY_HEADERS=1`, pin `TRUSTED_IP_HEADER` to the
   header your ingress writes (see `.env.example`). `docker-compose.yml` now
   defaults it to `x-forwarded-for`; override it for a proxy that writes only
   `x-real-ip`.
6. **Tailscale split profile:** `docker/tailscale/serve-public.json` now
   proxies only `/c`, `/status` and `/api/wallet`. Add a handler for a custom
   `MANTIS_PUBLIC_PATH`, and recreate the `tailscale-public` container.

Deployed artifacts (regenerate; old copies keep the old behaviour):

7. **css-background snippets** — earlier snippets usually pointed at the wrong
   URL and never fired. Regenerate and re-paste them, and declare your site's
   origin on the key ("your own site" on the key page, or `self_origins`).
8. **Windows device bundles** — re-run `install.ps1` so the tasks are
   re-registered from the corrected XML.
9. **Home Assistant receiver** — re-download the YAML and re-register the
   destination; the webhook id is no longer derived from the key id.
10. **Kandji** — re-paste `deploy/kandji/mantis-terminal-canary.zsh` into the
    library item. A Mac whose key is disabled or expired now fails visibly.
11. **CLI** — upgrade to 0.3.0 together with the server. Older CLIs read
    monitor state from the old status URL and will report keys as not
    monitored.

Repository settings (cannot be changed from the code):

12. Create a GitHub environment `production` with `main` as its only
    deployment branch, store `FLY_API_TOKEN` there, and delete the
    repository-level secret.
13. Delete or protect the `cli-v0.1.0`–`cli-v0.2.2` tags: `workflow_dispatch`
    runs the workflow file of the selected ref, so those tags still carry the
    old release workflow.

### New settings

| Setting | Default | Purpose |
| --- | --- | --- |
| `MANTIS_ENROLL_DESTINATIONS` | unset | `channel:target` pairs an enrollment key may attach |
| `MANTIS_ENROLL_KEYS_PER_HOUR` | `1000` | New keys one enrollment key may create per hour (`0` = no cap) |
| `DASHBOARD_BASE_URL` | derived | Origin used for dashboard links in alerts and `dashboard_url` |
| `TRUSTED_IP_HEADER` (compose) | `x-forwarded-for` | Now pinned by default in `docker-compose.yml` |
| `MANTIS_TARGET_USER` (bundle scripts) | unset | Account the per-user alarms are installed for when the script runs as root |

### Server 0.3.0

Enrollment keys and key ownership:

- An enrollment-scoped key can only mint a plain tripwire: `memo`,
  `external_id`, `response_kind` (`gif` or `empty`) and a dedupe window up to
  600 s. Expiry, monitor settings, redirect/HTML/JSON responses and the
  `mantis:device:` namespace are refused with `403`.
- Destinations from an enrollment key must be pre-approved
  (`MANTIS_ENROLL_DESTINATIONS`); its responses no longer carry activation
  error text. New keys per enrollment key are capped per hour.
- `external_id` claims resolve only inside the claimer's fleet. Enrollment
  keys record an owner (`owner_api_key_id` on `POST /api/api-keys`, default:
  the minting admin). Admins adopt another fleet's key only with
  `"adopt": true`. Reused responses carry `created_by_caller`.
- A claim never returns a disabled or expired key (`409`), and `expires_at`
  in the past is rejected at creation (`422`).
- `GET /api/keys?mine=1` lists only keys the caller created.

Alert delivery:

- The public trigger no longer drops requests by client IP before the key
  lookup; live keys are limited per key only.
- Any path under a trigger URL, any method and a trailing slash now fire the
  key, so bait placed in base-URL fields registers. The appended path is
  stored with the hit (`x-mantis-request-path`); clone-detector page URLs are
  stored as `x-mantis-page-url` / `x-mantis-page-referrer`.
- Keys can declare their own site origins (`self_origins`); hits whose
  Referer comes from them are ignored instead of masking a clone-site hit.
- Chat and email alerts link the dashboard, never the trigger URL. Webhook
  and Home Assistant payloads keep the trigger URL as data and gain
  `dashboard_url`; alerts show the Referer; long values are truncated.
- Removing a destination aborts its queued and retrying deliveries.
- Webhook destinations that point at the instance itself are refused. One
  deadline covers DNS and the request. IPv6 literals are checked as addresses.
- Refused destinations report one constant message; details go to the server
  log. Non-admins no longer see destination-derived error text for global
  destinations.

Dashboard and API:

- Status is served only at `/status/<publicId>.<tag>` and returns
  `{"status": "ok" | "tripped"}`. Anything else under `/status` is the same
  empty 404 as a blocked path.
- Admins can reveal and rotate the signing secret of a global webhook
  destination (settings → notifications).
- Audit records now cover API monitor resets, global destination changes and
  the dashboard paths that create keys or change routing and monitoring.
- Memos and destination targets may not contain control characters.
- Retention runs about hourly from `/api/cron/notifications` when the notify
  worker is disabled.
- Client-IP headers must carry an IP literal; a warning is logged when headers
  are trusted without a pin.
- The dev inbox stores credential headers as `[redacted]`.
- The Home Assistant receiver installer uses a stable, secret webhook id.
- Bait copy corrected: Office documents (Protected View), honey folder,
  `.netrc`, cookies, bookmarks, NFC label, PDF.

### CLI 0.3.0

- Text from the API or filesystem is printed inert (control characters shown
  as `\uXXXX`).
- `mantis cloudflare …` honours `--profile`, and rejects `--base-url`.
- `last` means the newest key this credential created. `rm` deletes exactly
  the ids it showed. Commands announce the key a symbolic ref resolved to.
- `mantis restore` without `--overwrite` no longer replaces a stored
  credential for a server that another profile already uses.
- Device bundles are validated in full before anything is written or run.
- `mantis device new` refuses to arm a reused key that another credential
  created, or that is disabled or set to expire.
- Monitor state is read through the API; `mantis doctor` no longer probes the
  public status path.
- `mantis watch` / `hits --follow` re-read a short overlap so late-committing
  hits are not skipped.
- On Windows, system helpers are launched by absolute path.
- `mantis backup` warns when writing inside a git work tree.

### Installers and device bundles (`@mantis/core` 0.2.0)

- css-background: escapes are six digits, so the snippet decodes to the
  trigger URL.
- Windows tasks: XML declaration matches the bytes written, schema element
  names for battery settings, explicit principals (Users group for logon,
  LOCAL SERVICE for wake and network). `install.ps1` checks each registration
  and exits non-zero on failure.
- Boot and wake alarms retry up to five times; the Linux boot unit no longer
  holds up boot.
- `install.sh` run with `sudo` installs the per-user alarms for the calling
  user (macOS: the console user). On Linux a direct root login installs for
  root; `MANTIS_TARGET_USER` overrides.
- Home Assistant: the bridge automation ignores Mantis automations; the
  receiver's activation filter is a condition; memo text cannot break out of
  the YAML comment.
- systemd units are installed root-owned. The clone detector normalises the
  expected hostname.

### Edge worker 0.2.0

- Chat alerts name the canary by a URL fragment instead of linking the live
  trigger URL.
- Caller-controlled values are length-limited after escaping.
- Forwarding retries up to twice on 429, 5xx and timeouts.
- README and deploy guide describe the Workers Free daily request quota.

This is a source release: deploy the `mantis-edge` directory with your
existing Wrangler configuration and encryption key.

### IoT helper 0.2.0

- Log watchers read in bounded chunks with per-poll caps, so a large burst
  cannot exhaust memory before a login alert is delivered.

### CI and deployment

- `cli-release.yml` validates the version, passes values through `env:` and
  gives only the release job a write token.
- `fly-deploy.yml` deploys `main` only and runs in the `production`
  environment.
- `docker-compose.yml`: the cloudflared token is passed through the
  environment, not the command line; tunnel credentials no longer reach the
  app container.
- Kandji scripts send only permitted fields, fail visibly on refusals, and
  neutralise device names in output.

### Not yet verified on the real platform

Covered by tests and correct by specification, but check them once:

- Windows: `schtasks /create /tn "Mantis Logon t" /xml <generated xml>` for the
  logon, wake and network tasks, then one logon as a non-admin account.
- Home Assistant: paste both YAML files and run "Check configuration".
- Tailscale split profile, from outside the tailnet: `/c/<id>` fires and
  `/login` is a 404.
- cloudflared starts with `TUNNEL_TOKEN` and no token shows in `ps`.
- The first CLI release and Fly deploy run with the changed workflows.
