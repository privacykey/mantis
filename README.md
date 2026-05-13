# mantis

Self-hostable mantis key service. API-first.

You mint a unique URL; when something fetches it, you get notified through the destinations you configure.
Useful for catching insider snooping, leaked credentials, opened "honeypot" docs, etc.

This is **v0.1.0** — the first release. Includes:
- HTTP API + public trigger endpoint
- Terminal CLI in [`cli/`](./cli/README.md)
- Web dashboard at `/login` → `/keys`
- Reliability: webhook retry queue, hit dedup, UA + bot parsing
- File keys: Word `.docx`, Excel `.xlsx`, PowerPoint `.pptx`, PDF
- Honey directory: `.zip` bundle of pre-baited files for shared-drive deployment
- Host-event keys: shell, login, boot installers with parsed host context including SSH client IP
- More host events: sudo invocation, wake from sleep, network attach
- Uptime Kuma integration: per-key status URL that flips on hit, watched by Kuma → fan-out via its 80+ channels
- Direct notification destinations: webhook, email, Slack, Discord, Teams
- Web-embed snippets: CSS-background + JS clone-detector (with hostname filter), exposed as new `/install` types
- Smart-home tripwires: Home Assistant + Scrypted installer snippets, plus an optional LAN IoT helper for unexpected device-online/login events

Roadmap: more direct channels (Telegram/ntfy/Pushover/Mattermost/Pushbullet/Matrix + Signal via signal-cli-rest-api), fast-redirect first-class keys, email-address keys, DNS keys, macOS menubar app, multi-tenant orgs.

## Quickstart — Docker (recommended)

```bash
git clone <this repo> mantis && cd mantis
docker compose up -d
docker compose logs mantis | grep "bootstrap API key" -A1
```

The first boot prints a bootstrap API key. Copy it; it won't be shown again.

### Option A — Use the dashboard

Open **http://localhost:3000** → paste your API key → you're in.

- `/keys` — list with hit counts, inline disable/enable
- `/keys/new` — create a key (memo + response shape + notification destinations)
- `/keys/<id>` — detail view with the mantis URL, copy button, and a feed of recent hits (click any row to expand headers)
- `/inbox` — built-in webhook capture (dev only)

The dashboard authenticates via an httpOnly cookie containing the API key. Logout clears the cookie.

### Option B — Use the CLI

```bash
cd cli && npm install && npm run build && npm link
mantis --key mantis_live_... login --url http://localhost:3000

# Point the webhook at the built-in dev inbox (no webhook.site needed)
mantis new "first mantis" -w http://localhost:3000/inbox/demo

# Trigger the URL it printed, then open the viewer:
open http://localhost:3000/inbox

mantis list
mantis hits <key-id>
mantis watch       # tails hits live
mantis doctor      # checks CLI config, server health, and split hosts
```

For spreadsheet-driven setup, bulk-create URLs and get a CSV back with one
generated URL per row:

```bash
mantis bulk-create \
  --csv smart-home-areas.csv \
  --out smart-home-areas-with-urls.csv \
  --memo-template "{{area}} - {{device}}"
```

See [`cli/README.md`](./cli/README.md) for the full command reference.

### Performance Checks

Benchmarks live under [`bench/`](./bench/README.md) and are intentionally local,
not CI-gated:

```bash
npm run bench:cli                  # CLI startup/rendering overhead
npm run bench:edge                 # mantis-edge worker, requires wrangler dev
MANTIS_BENCH_KEY=mantis_live_... npm run bench:server
```

### Option E — Smart Home / IoT events

Mantis can fire from Home Assistant, Scrypted, or a small LAN watcher:

```bash
mantis install <key-id> --type homeassistant --out mantis-ha.yaml
mantis install <key-id> --type scrypted --out mantis-scrypted.js

# Choose the server/profile at generation time:
mantis --profile prod install last --type homeassistant --out mantis-ha-prod.yaml
mantis --profile lab install last --type homeassistant --out mantis-ha-lab.yaml

# Optional LAN watcher for unexpected MAC/IP appearances or syslog login lines.
cd iot-helper
cp config.example.json mantis-iot.json
node bin/mantis-iot-helper.js --config mantis-iot.json --once --dry-run
```

Smart-home hits show structured context in the dashboard and CLI via
`X-Mantis-Event`, `X-Mantis-Device`, `X-Mantis-Entity-Id`, and related headers.
Generated snippets contain literal trigger URLs, so they keep reporting to the
profile/server used by `mantis install`; they do not consult CLI profiles at
runtime.

### Option C — curl directly

```bash
export MANTIS=http://localhost:3000
export KEY=mantis_live_...   # from logs above

# Mint a key
curl -sX POST $MANTIS/api/keys \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"memo":"first mantis","destinations":[{"channel":"webhook","target":"https://webhook.site/<your-id>"}]}'
# → { "id":"...", "public_id":"...", "url":"http://localhost:3000/c/...", ... }

# Trigger it
curl -i http://localhost:3000/c/<public_id>
# → 200 OK with a 1×1 transparent GIF

# Inspect hits
curl -s $MANTIS/api/keys/<id>/hits -H "Authorization: Bearer $KEY" | jq
```

## Quickstart — local dev

```bash
npm install
cp .env.example .env
# edit .env: at minimum set DATABASE_URL

# Start postgres separately (docker run -p 5432:5432 ... or use Neon/Supabase)
npm run db:migrate
npm run dev
```

First request prints a bootstrap API key to stdout.

## Deployment

The mantis needs a public-reachable URL. Pick the option that matches where you want to run it.

| | What runs where | Public URL via | When this is right |
|---|---|---|---|
| **A. Local Docker** | Your machine | None (localhost only) | Development, testing, air-gapped use |
| **B. Docker + Tailscale** | Your machine | Tailscale Funnel (`*.ts.net`) | Personal mantis on a laptop / home server — works behind CGNAT |
| **C. Docker + Cloudflare Tunnel** | Your machine | Your own domain on Cloudflare | You already have a Cloudflare-hosted domain; want SSO via Cloudflare Access |
| **E1. Railway** | Railway (long-running) | `*.up.railway.app` or custom | Set-and-forget; the worker runs natively (no cron config) |
| **E2. Fly.io** | Fly (long-running) | `*.fly.dev` or custom | Same shape as Railway; broader regional choice |
| **E3. Render** | Render (long-running) | `*.onrender.com` or custom | Same shape; free tier exists but cold-starts after 15 min idle |

### A. Local Docker (no tunnel)

```bash
git clone <this repo> mantis && cd mantis
docker compose up -d
docker compose logs mantis | grep "bootstrap API key" -A1
```

Mantis is bound to `127.0.0.1:3000` by default. Reachable from the host only. To expose to LAN: set `MANTIS_BIND_HOST=0.0.0.0` in `.env`.

### B. Docker + Tailscale

```bash
cp .env.example .env
# Simple public Funnel:
#   Set TS_AUTHKEY, TS_HOSTNAME, PUBLIC_BASE_URL
docker compose --profile tailscale up -d

# Or split public triggers from private dashboard/API:
#   Set TS_AUTHKEY, TS_PRIVATE_HOSTNAME, TS_PUBLIC_HOSTNAME,
#       PUBLIC_BASE_URL, PUBLIC_ONLY_HOSTS, DASHBOARD_HOSTS
docker compose --profile tailscale-split up -d
```

Full walkthrough — one-time tailnet setup, simple Funnel, and split Serve + Funnel — is in **[`deploy/tailscale.md`](./deploy/tailscale.md)**.
For public exposure, also apply the edge-limit guidance in **[`deploy/edge-limits.md`](./deploy/edge-limits.md)**.

### C. Docker + Cloudflare Tunnel (+ optional Access)

```bash
cp .env.example .env
# Set: CLOUDFLARE_TUNNEL_TOKEN, PUBLIC_BASE_URL
docker compose --profile cloudflared up -d
```

Full walkthrough — Zero Trust team creation, tunnel hostname routing, identity-provider config, and the dashboard-vs-API gating decision — is in **[`deploy/cloudflare.md`](./deploy/cloudflare.md)**.
Add the Cloudflare URL and rate limiting rules from **[`deploy/edge-limits.md`](./deploy/edge-limits.md)** before broad public use.

> 🛈 **Gating `/api/*` behind Cloudflare Access**: the CLI now supports auth-passthrough. Use `mantis cloudflare login --app=…` for browser-SSO short-lived JWTs (requires `cloudflared` installed locally), or `mantis cloudflare set-service-auth` for headless service-key use. The server stays unaware of Cloudflare — all auth state lives on your machine. Details + the Access app config in [`deploy/cloudflare.md`](./deploy/cloudflare.md#step-6-optional--cloudflare-access).

### E1. Railway

See **[`deploy/railway.md`](./deploy/railway.md)** for the 8-step walkthrough. Summary: fork repo → New from GitHub → add Postgres add-on → set env vars (`DATABASE_URL`, `PUBLIC_BASE_URL`, `AUTO_MIGRATE=1`, optional `BOOTSTRAP_API_KEY`) → generate a domain → done. Worker runs natively. For WAF/rate limits, put a Cloudflare-proxied custom domain in front; see **[`deploy/edge-limits.md`](./deploy/edge-limits.md#railway)**.

### E2. Fly.io

```bash
cp deploy/fly.toml.example fly.toml
# edit `app =` to a unique name; edit PUBLIC_BASE_URL after first deploy
fly launch --no-deploy --copy-config
fly postgres create --name mantis-db
fly postgres attach mantis-db
fly secrets set PUBLIC_BASE_URL=https://<app>.fly.dev BOOTSTRAP_API_KEY=mantis_live_...
fly deploy
```

Fly concurrency protects the VM, not the public URL. For app-layer URL/rate limits, use a Cloudflare-proxied custom domain; see **[`deploy/edge-limits.md`](./deploy/edge-limits.md#flyio)**.

### E3. Render

```bash
cp deploy/render.yaml.example render.yaml
# commit and push; then create a Render Blueprint pointing at the repo
```

Free tier spins down after 15 min idle → first mantis trigger after idle takes 30–60s. For real mantis use, upgrade to Starter ($7/mo) or use Railway/Fly.
For app-layer URL/rate limits, use a Cloudflare-proxied custom domain; see **[`deploy/edge-limits.md`](./deploy/edge-limits.md#render)**.

## Choosing between B and C

Both give you a public HTTPS URL for mantis running on your own hardware. The differences:

| | Tailscale (B) | Cloudflare (C) |
|---|---|---|
| Need to own a domain? | No (uses `*.ts.net`) | Yes (must be on Cloudflare) |
| Setup steps | ~3 | ~5 |
| Dashboard SSO | Tailnet membership / ACLs in split mode | Cloudflare Access (one app, one policy) |
| DDoS protection | No | Yes (CF edge) |
| Edge regions | Limited Tailscale relays | CF global edge |
| Privacy posture | Tailscale sees traffic metadata | Cloudflare sees all traffic + bodies |
| Free tier | Up to 100 devices | Unlimited tunnels, 50 Access seats |
| Best for | Personal, hobby, private dashboard/API without owning a domain | Custom domain, brand-protection |

## Single-user by default

Mantis is single-user out of the box. The first API key minted on a fresh
deploy is automatically `is_admin = true` (the bootstrap path sets the flag).
That key is the operator: it sees and manages every key on the instance.
Additional API keys created later default to **non-admin** — they can only
see and manage the keys they created themselves.

If you only ever mint one API key for your deploy you'll never notice the
distinction; the schema is shaped that way so it's easy to later promote a
shared instance to multi-user. Until then, treat every operator as admin and
keep your bootstrap key safe. The `audit log` (`mantis audit log`, admin-only)
records create / update / delete / login events across the instance.

## Configuration

See `.env.example` for the full list. Required:

- `DATABASE_URL` — Postgres connection string
- `PUBLIC_BASE_URL` — used to construct key URLs

Optional:

- `SMTP_URL`, `SMTP_FROM` — enables email notifications
- `BOOTSTRAP_API_KEY` — pre-seed the first API key (for IaC). If unset, one is minted and printed on first boot.
- `AUTO_MIGRATE=1` — apply pending migrations on app boot (use on container deploys, not Vercel)
- `MANTIS_PUBLIC_PATH` — defaults to `/c`. Changing this only affects the URLs the API advertises; to actually serve from a different path, put a reverse proxy in front and rewrite to `/c/<id>`.
- `LOG_LEVEL` — `trace|debug|info|warn|error` (default `info`)
- `MANTIS_DUPLICATE_LOG_LIMIT` — duplicate hit rows to store per dedupe window after the first hit (default `10`; `0` stores only the first).
- `MANTIS_MAX_STORED_REQUEST_FIELD_CHARS` — cap for stored `user-agent`, `referer`, and individual header values (default `16384`).
- `MANTIS_MAX_STORED_HEADER_SNAPSHOT_CHARS` — cap for the total stored header snapshot (default `65536`).
- `ENABLE_DEV_INBOX` — `1` to enable the unauthenticated `/inbox` webhook capture. Default: disabled.

## API

All `/api/*` endpoints require `Authorization: Bearer mantis_live_...`.

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/keys` | Create a key. Body: `{ memo, response_kind?, response_payload?, destinations?, dedupe_window_seconds?, expires_at? }` |
| `GET` | `/api/keys` | List keys (paginated, `?limit=&cursor=`) |
| `GET` | `/api/keys/:id` | Get one |
| `PATCH` | `/api/keys/:id` | Update memo/notify/response/`disabled` |
| `DELETE` | `/api/keys/:id` | Hard-delete key + cascade hits |
| `GET` | `/api/keys/:id/hits` | Paginated hit log |
| `GET` | `/api/hits/recent?since=<iso>&key_id=<id>` | Recent hit feed across accessible keys, used by CLI watch mode |
| `GET` | `/api/keys/:id/download?format=docx\|xlsx\|pptx\|pdf\|folder` | Download a generated mantis file or `folder` honey-directory zip (cookie or Bearer auth) |
| `GET` | `/api/keys/:id/install?type=<type>[&format=json]` | Generated installer snippet for host/web/IoT events (shell/macOS/Linux/Windows/Home Assistant/Scrypted) — cookie or Bearer auth |
| `POST` | `/api/keys/:id/reset` | Reset a key's latched monitor state. Cookie or Bearer auth. |
| `GET` `HEAD` | `/status/:public_id` | **Public.** Uptime-monitor status endpoint. 200 = ok, 503 = tripped, 404 = not monitored / disabled / unknown. Does not record a hit. |
| `GET` | `/api/api-keys` | List keys (hashes never returned) |
| `POST` | `/api/api-keys` | Mint a new key (plaintext returned **once**) |
| `DELETE` | `/api/api-keys/:id` | Revoke (soft) |
| `GET` `HEAD` `POST` | `/c/:public_id` | **Public.** Records a hit, returns the configured response. |

### Response kinds for the trigger endpoint

| `response_kind` | Payload | Result |
|---|---|---|
| `gif` (default) | — | `200` + 1×1 transparent GIF |
| `empty` | — | `204 No Content` |
| `json` | any | `200` + JSON body |
| `redirect` | `{"url":"..."}` | `302` to that URL |
| `html` | `{"html":"..."}` | `200 text/html` |

### Webhook payload

```json
{
  "type": "mantis.hit",
  "key": { "id": "...", "public_id": "...", "memo": "...", "url": "..." },
  "hit": {
    "id": "...",
    "occurred_at": "2026-05-12T10:00:00.000Z",
    "ip": "203.0.113.5",
    "user_agent": "Mozilla/5.0 ...",
    "referer": null,
    "ua_browser": "Chrome",
    "ua_os": "macOS",
    "ua_device": "desktop",
    "bot_label": null,
    "is_duplicate": false,
    "headers": { "host": "...", "accept": "...", "x-mantis-source": "shell", "x-mantis-user": "alice", "x-mantis-ssh-client": "203.0.113.42 54321 22", "..." : "..." }
  }
}
```

Webhook payloads also include a parsed `host_context` object when the hit came from one of our installer snippets:

```json
"host_context": {
  "source": "shell",
  "user": "alice",
  "host": "alice-mbp",
  "ssh_client": "203.0.113.42 54321 22",
  "ssh_client_ip": "203.0.113.42",
  "ssh_connection": "203.0.113.42 54321 10.0.0.5 22",
  "tty": "/dev/pts/0",
  "sudo_cmd": null,
  "network_interface": null
}
```

For a `shell-sudo` hit you'd see `"source": "shell-sudo", "sudo_cmd": "apt update --quiet"`. For a `linux-network` hit, `"source": "linux-network", "network_interface": "wlan0"`. Fields not relevant to the installer are `null`.

`host_context` is `null` for hits that didn't include `X-Mantis-*` headers (e.g., a file/folder key, or a regular curl to the URL).

Webhooks are sent through a **Postgres-backed retry queue** (no Redis required). On failure the notification is retried with exponential backoff: 1m, 5m, 30m, 2h, 12h (each with ±20% jitter), giving up after 5 attempts. Delivery state is tracked on each hit's `notifications` array.

## File keys

Ten file formats supported, each embedding the mantis URL so the file's "trigger" fires when the file is opened in the appropriate app:

| Format | Mechanism | Best in | Notes |
|---|---|---|---|
| `.docx` | External-image relationship in OOXML | Word, LibreOffice Writer | Most reliable — fires on render, also from email attachments after "Enable Editing" |
| `.xlsx` | Same external-image trick, attached to a worksheet drawing | Excel, LibreOffice Calc | Identical reliability to DOCX |
| `.pptx` | Same external-image trick on slide 1 | PowerPoint, Keynote (some), LibreOffice Impress | Same as above |
| `.pdf` | **Combo**: `/OpenAction → /URI` + clickable `/Link` annotation | Adobe Reader, Foxit, most enterprise PDF readers | Less reliable — Chrome's PDFium viewer doesn't fire OpenAction; macOS Preview doesn't either. The clickable link covers the "user reads + clicks" case in those viewers. |
| `.svg` | `<image href>` referencing the trigger URL | Browsers, some image viewers, photo libraries | Apps that raster-thumbnail may not fire on preview — opening the original always does |
| `.html` | `<img src>` in a standalone page | Any browser, web-clip notes | Fires on first render |
| `.md` | `![](URL)` image syntax | Joplin / Trilium / Logseq / Gitea README | Fires when the renderer loads images |
| `.eml` | RFC 5322 message with HTML body `<img src>` | Thunderbird, Apple Mail, mail-archive previews | Fires on message render |
| `.ics` | iCalendar event with `ATTACH;FMTTYPE=image/png` + `URL` | Apple Calendar, some CalDAV clients | Behavior varies by client |
| `.vcf` | vCard 4.0 with `PHOTO;VALUE=URI` | macOS / iOS Contacts, CardDAV clients | Fires when the contact's avatar renders |

See **[self-hosted-apps.md](./self-hosted-apps.md)** for per-app recipes (Immich, Paperless, Joplin, Vaultwarden, dashboards, code hosts, etc.).

```bash
# Create key + generate any/all formats in one step
mantis new "Q4 forecast" \
  -w http://localhost:3000/inbox/q4 \
  --docx ./forecast.docx \
  --xlsx ./forecast.xlsx \
  --pptx ./forecast.pptx \
  --pdf  ./forecast.pdf \
  --svg  ./forecast.svg \
  --html ./forecast.html \
  --md   ./forecast.md \
  --eml  ./forecast.eml \
  --ics  ./forecast.ics \
  --vcf  ./forecast.vcf

# Or download a file for an existing key
mantis download <key-id> --docx ./out.docx
mantis download <key-id> --pdf ./out.pdf

# Dashboard: key detail page → "file keys" card has download links for all formats
# API: GET /api/keys/<id>/download?format=docx|xlsx|pptx|pdf|svg|html|md|eml|ics|vcf  (Bearer or session)
```

**Office reader caveats**:
- ✅ Microsoft Office desktop apps — fetch external image on render (subject to **Protected View** for files marked "from internet"; first "Enable Editing" click triggers).
- ✅ LibreOffice (Writer/Calc/Impress) — fetches external content by default.
- ⚠ Office on the web / Office 365 in browser — depends on tenant policy.
- ❌ macOS Quick Look — does not render external content.

**PDF reader caveats**:
- ✅ Adobe Acrobat Reader — follows `/OpenAction → /URI` (may show a one-time trust prompt for the host).
- ✅ Foxit Reader, PDF-XChange — typically follows OpenAction.
- ⚠ Chrome, Edge, Firefox built-in viewers — OpenAction not honored; mantis fires only if user clicks the visible "View the latest version online" link.
- ❌ macOS Preview — OpenAction not honored; click-the-link fallback works.

All generated files include placeholder body text (`CONFIDENTIAL DRAFT — do not distribute.`). Edit the file after download to make it look authentic.

## Honey directory

A `.zip` bundle of pre-baited files, all wired to the same key. Drop the extracted folder on a shared drive; any file inside that gets opened, double-clicked, or `cat`'d fires the mantis.

```bash
mantis new "Q4 Leadership Plans" \
  -w http://localhost:3000/inbox/folder \
  --folder ./honey.zip

# Or from the dashboard: key detail page → "honey directory (zip)" → ↓ folder.zip
# Or API: GET /api/keys/<id>/download?format=folder
```

The unzipped folder contains 9 bait files, each independently triggering the same key:

| File | Trigger when |
|---|---|
| `Q4 Salary Review.xlsx` | Opened in Excel / LibreOffice Calc |
| `Restructuring Memo - Draft.docx` | Opened in Word / LibreOffice Writer |
| `All-Hands Q4 Plans.pptx` | Opened in PowerPoint / LibreOffice Impress |
| `Layoff Schedule 2026.pdf` | Opened in Adobe Reader (`/OpenAction`) or clicked link |
| `passwords.txt` | Cat'd / read — has fake credentials + URL line at the bottom |
| `database-credentials.txt` | Same pattern — fake DB creds + URL |
| `README.txt` | Reading the directory's "what is this" file |
| `Open in Browser.url` | Double-clicked on Windows (Internet Shortcut) |
| `Latest Version.webloc` | Double-clicked on macOS (URL bookmark) |

Note: this does **not** fire automatically when someone browses the folder in Finder/Explorer — that requires DNS infrastructure (a future stage). What it *does* give you is high-surface honeypot detection: a curious user spelunking the directory will open at least one of those files, and any of them triggers the alert.

Fake credentials in `passwords.txt` / `database-credentials.txt` use AWS's and Stripe's documented example keys (`AKIAIOSFODNN7EXAMPLE`, `sk_live_4eC39HqLyjWDarjtT1zdp7dc`) — publicly known fakes, not real credentials anywhere.

## Host-event keys

Want to know when *your own machine* boots, logs in, or starts a shell? Create a key, then install one of the generated snippets on the host you want to watch:

| Type | Fires when | Platform |
|---|---|---|
| `shell` | Any shell starts (covers SSH logins) | POSIX (macOS, Linux) |
| `shell-sudo` | You run `sudo` from a configured shell (captures the original command) | POSIX |
| `macos-login` | You log in to the macOS desktop | macOS |
| `macos-boot` | The Mac boots, before any user logs in | macOS (sudo required) |
| `macos-wake` | Mac wakes from sleep | macOS (requires `brew install sleepwatcher`) |
| `macos-network` | Network attaches / Wi-Fi joins / VPN connects | macOS |
| `linux-boot` | systemd brings the network up | Linux (sudo required) |
| `linux-wake` | System resumes from suspend / hibernate | Linux (sudo required) |
| `linux-network` | NetworkManager brings an interface up | Linux (sudo required, NetworkManager) |
| `windows-logon` | Any user logs on | Windows |
| `windows-wake` | System resumes from sleep / hibernate | Windows |
| `windows-network` | Network profile connects (Wi-Fi join, Ethernet, VPN) | Windows |

Get the installer for a key via:

```bash
# CLI — prints to stdout + install instructions to stderr
mantis install <key-id> --type macos-login

# Or write directly to a file:
mantis install <key-id> --type macos-login --out ~/Library/LaunchAgents/com.mantis.login.plist

# From the dashboard: key detail page → "install on a host" card → tab → copy/download
# Or API: GET /api/keys/<id>/install?type=<type>  (cookie or Bearer auth)
#         GET /api/keys/<id>/install?type=<type>&format=json  for metadata
```

The snippets are designed to be unobtrusive — backgrounded execution, 3–10s timeouts, output redirected to `/dev/null`. They won't slow your shell startup or hang your boot if the mantis server is unreachable.

**Example: alert me on every SSH login**

```bash
# 1. Create the key
mantis new "ssh login alert" -w https://my-webhook.example.com

# 2. Generate + install the shell snippet
mantis install <key-id> --type shell --out ~/.mantis.sh
echo 'source ~/.mantis.sh' >> ~/.zshrc

# 3. SSH in (or start any shell) — webhook fires.
```

**Example: alert me when my Mac boots**

```bash
mantis install <key-id> --type macos-boot --out com.mantis.boot.plist
sudo mv com.mantis.boot.plist /Library/LaunchDaemons/
sudo chown root:wheel /Library/LaunchDaemons/com.mantis.boot.plist
sudo launchctl load /Library/LaunchDaemons/com.mantis.boot.plist
```

These keys behave identically to a normal HTTP key server-side — the difference is the install helpers that wire the trigger to host events. The same key can serve any installer type, so you can reuse one key for shell + login + boot if you don't want to discriminate.

### Web-embed snippets (CSS / JS)

In addition to host-event installers, the same `/install` endpoint generates two web-embed snippets you can paste into your own website:

| Type | Fires when | Use case |
|---|---|---|
| `css-background` | The CSS is rendered anywhere (browser loads the URL as a background image) | Detect when someone copies your stylesheet to their own site. **Fires on your own site too** — distinguish by Referer header. |
| `js-clone-detector` | The script runs on a hostname other than the expected one (or any subdomain of it) | Detect site cloning / phishing copies. Includes a runtime hostname check so it does **not** fire on your real site. |

```bash
# CSS embed
mantis install <key-id> --type css-background --out ./mantis-canary.css

# JS embed with hostname check
mantis install <key-id> --type js-clone-detector --hostname example.com --out ./mantis.js
```

Both are also visible as tabs ("web CSS", "web JS") on the key detail page in the dashboard, with the JS tab exposing an inline hostname input field. The dashboard tab regenerates the snippet whenever you change the hostname.

The CSS uses partial escape-sequence obfuscation on the URL (`\6c` for `l`, etc.) so the canary URL is less obvious to a casual reader of the stylesheet — browsers parse it identically.

The JS snippet sends explicit `?l=<location>&r=<referrer>` query params alongside the canary URL so you can identify the cloning site even when the Referer header is stripped (strict referrer policies, mixed-protocol downgrades, etc.).

### Smart-home snippets (Home Assistant / Scrypted)

The `/install` endpoint also generates smart-home snippets:

| Type | Fires when | Use case |
|---|---|---|
| `homeassistant` | Any Home Assistant automation calls the generated `rest_command` | Door opened, lock unlocked, automation triggered, Scrypted sensor changed, Apple Home device bridged through HA |
| `scrypted` | A Scrypted Script sees a selected device/interface event | Person/package/vehicle detection from Scrypted Smart Motion Sensor without routing through HA |

```bash
mantis install <key-id> --type homeassistant --out mantis-ha.yaml
mantis install <key-id> --type scrypted --out mantis-scrypted.js
```

Use `--profile` on the `install` command to decide which server the generated
snippet reports to. The snippet stores a literal URL, so changing the CLI's
current profile later does not affect already-installed Home Assistant or
Scrypted automations.

For devices that do not expose useful webhooks, [`iot-helper/`](./iot-helper/README.md) can watch LAN neighbor tables and log files, then fire the same Mantis URL for unexpected online/login events.

### What information each installer captures

Each installer sends `X-Mantis-*` headers alongside the hit, which the server parses into a structured `host_context` object exposed on the API + dashboard + CLI.

| Header | Set by | Useful for |
|---|---|---|
| `X-Mantis-Source` | every installer | which installer fired (shell / shell-sudo / macos-login / macos-boot / macos-wake / macos-network / linux-boot / linux-wake / linux-network / windows-logon / windows-wake / windows-network / homeassistant / scrypted / iot-network / iot-log) |
| `X-Mantis-User` | `shell`, `shell-sudo`, `macos-login`, `macos-network`, `macos-wake`, `windows-logon`, `windows-wake`, `windows-network` | OS account |
| `X-Mantis-Host` | every installer | which of your machines |
| `X-Mantis-SSH-Client` | `shell`, `shell-sudo` (when SSH'd in) | **the SSH client's IP** |
| `X-Mantis-SSH-Connection` | `shell`, `shell-sudo` (when SSH'd in) | full sshd connection tuple |
| `X-Mantis-TTY` | `shell` | pty path; distinguishes interactive from scripted |
| `X-Mantis-Sudo-Cmd` | `shell-sudo` | the args passed to sudo (e.g., `apt update --quiet`) |
| `X-Mantis-Network-Interface` | `linux-network` | interface name (`wlan0`, `eth0`, etc.) |
| `X-Mantis-Event` | Home Assistant / Scrypted / IoT helper | event label (`door-opened`, `person-detected`, `unexpected-online`, `device-login`) |
| `X-Mantis-Device` | Home Assistant / Scrypted / IoT helper | friendly device name |
| `X-Mantis-Entity-Id` | Home Assistant / Scrypted | entity/device id |
| `X-Mantis-Automation` | Home Assistant | automation or scene name |
| `X-Mantis-Area` | Home Assistant / Scrypted | room/area |
| `X-Mantis-Iot-Mac` / `X-Mantis-Iot-Ip` | IoT helper | observed MAC/IP |

(Boot-time installers don't include `X-Mantis-User` because no user is logged in yet.)

The big win is `$SSH_CLIENT` — when someone SSHes into your machine and the shell snippet fires, the mantis records the **SSH client's IP**, not just the machine's own public IP. The dashboard surfaces this prominently as `← <client-ip>` next to the user/host context. The CLI shows the same:

```
$ mantis hits <key-id>
when  ip   who                                              tag   notify
1s    ::1  shell · root · @ prod-bastion · ← 203.0.113.42   curl  ✓1
1s    ::1  shell · alice · @ alice-mbp                      curl  ✓1
```

Empty / missing X-Mantis headers (e.g., a non-SSH local shell, or a boot event with no user) are simply not displayed, so the chip stays compact.

## Uptime Kuma integration

Uptime Kuma integration lets you piggyback on [Uptime Kuma](https://github.com/louislam/uptime-kuma)'s 80+ notification integrations when you prefer status-monitor fan-out over mantis's built-in notification destinations.

The mechanic: every key has a per-key *status URL* at `/status/<public_id>` that flips between OK (HTTP 200) and tripped (HTTP 503) when the mantis fires. Point a Uptime Kuma HTTP(s) monitor at that URL — Kuma detects the status code or body change and fires its configured notifications.

### Modes

| `monitor_mode` | When tripped | When does it clear? |
|---|---|---|
| `off` (default) | never (status URL returns 404) | — |
| `latch` | once *any* hit recorded | manual reset via `POST /api/keys/<id>/reset` |
| `window` | any hit within `monitor_window_seconds` (default 300) | automatically when the newest hit ages out |

### Setup walkthrough

```bash
# 1. Pick a key and enable monitoring
mantis monitor <key-id> --mode latch
#   → status URL: http://mantis.example.com/status/<public_id>
#   → current:    ok

# 2. In Uptime Kuma → Add new monitor:
#      Monitor type:        HTTP(s)
#      URL:                 http://mantis.example.com/status/<public_id>
#      Heartbeat Interval:  30s (or longer; Kuma minimum 20s)
#      Status code accepted: 200
#      → Save and attach your preferred notifications

# 3. Test it: trigger the mantis URL
curl http://mantis.example.com/c/<public_id>

# Within 30s, Uptime Kuma sees the status URL flip 200 → 503,
# and fires its configured Discord/Slack/Teams/whatever notifications.

# 4. When you've acknowledged the alert:
mantis reset <key-id>   # in latch mode; window mode auto-resets
```

### Status endpoint behavior

| Key state | `GET /status/<public_id>` |
|---|---|
| Doesn't exist | `404` `{"error":"not_monitored"}` |
| `monitor_mode = off` | `404` `{"error":"not_monitored"}` (same as nonexistent — no info leak) |
| Disabled or expired | `404` `{"error":"not_monitored"}` (Uptime Kuma won't keep alerting on a key you've shut down) |
| Active, no trip | `200` `{"status":"ok","mode":"latch"\|"window"}` |
| Active, tripped | `503` `{"status":"tripped","tripped_at":"<iso>","mode":...}` |

All responses include `Cache-Control: no-store`. The status endpoint **does not record a hit** — Uptime Kuma can poll it forever without filling your hits log.

### Notes

- Same key still records hits and dispatches configured notification destinations on `/c/<public_id>` — `/status/<public_id>` is a separate read-only reflection of state.
- Uptime Kuma is optional. The status URL is plain HTTP(s); any monitor that watches for status-code or body changes (e.g., Pingdom, BetterUptime, healthchecks.io, your own cron) works.
- In `latch` mode, switching to `off` then back to `latch` does not lose trip state — it's derived from `hits` filtered by `monitor_reset_at`.

## Reliability

### Hit dedup
Each key has a `dedupe_window_seconds` (default **60**). Repeat hits to the same key within that window are still recorded (so forensics are intact), but they are marked `is_duplicate: true` and don't fire notifications. Set to `0` to disable.

### Notification retry queue
Notifications are inserted into a `notifications` table on hit. A background worker claims pending rows (`FOR UPDATE SKIP LOCKED` — safe for multiple instances), attempts delivery with a 5s timeout, and on failure schedules the next attempt with exponential backoff. Status (`pending` / `in_flight` / `succeeded` / `failed` / `aborted`) is surfaced in the dashboard, CLI (`mantis hits <id>`), and API (`GET /api/keys/<id>/hits`).

**Worker mode** (default for non-Vercel deployments):
- `instrumentation.ts` starts the worker on boot. Disable with `RUN_NOTIFY_WORKER=0`.

**Cron mode** (Vercel and other serverless):
- Worker is skipped automatically when `VERCEL` env is set.
- Configure Vercel Cron (or external scheduler) to hit `POST /api/cron/notifications` every minute.
- Optional auth: set `CRON_SECRET` and the endpoint requires `Authorization: Bearer $CRON_SECRET`.

```json
// vercel.json
{
  "crons": [{ "path": "/api/cron/notifications", "schedule": "* * * * *" }]
}
```

### User-Agent + bot detection
Hits are enriched with parsed UA (`ua_browser`, `ua_browser_version`, `ua_os`, `ua_device`) via `ua-parser-js`, plus a `bot_label` for known crawlers and HTTP clients (googlebot, curl, python-requests, headless-chrome, etc.). Bots aren't suppressed — they're labeled so you can decide.

## Dev inbox

A built-in webhook capture, only enabled with `ENABLE_DEV_INBOX=1`:

- `ANY http://localhost:3000/inbox/<any-path>` — captures the request into a 100-entry in-memory ring buffer
- `GET /inbox` — live-updating viewer (polls every 1s, pretty-prints JSON bodies)
- `GET /api/inbox` — same data as JSON; supports `?slug=foo&since=<id>`
- `DELETE /api/inbox` — clear the buffer

Use it as your webhook target while developing, instead of webhook.site. State is in-memory only — it resets when the server restarts. Do not expose it in production.

## Operational notes

- **API keys are stored as SHA-256 hashes.** Keys are random 192-bit keys with the `mantis_live_` prefix (matches GitHub's secret-scanning format, so a leaked key in a public repo will trigger their alerting). Bcrypt/argon2 is not used here — slow hashing only helps against low-entropy passwords; for full-entropy API keys, SHA-256 is the standard (GitHub PATs, Stripe restricted keys, etc.).
- **Disabled or expired keys** still return the configured response — they just don't record a hit or fire notifications. This prevents an attacker from probing for valid key IDs by looking for differential responses.
- **No long-running background workers.** Notifications dispatch via Next.js `after()`, retries via a Postgres-backed queue (no Redis required) — both run in the request lifecycle, so the same code runs on Vercel Functions, Railway, Fly, and self-host Docker without any worker config.

## Project layout

```
src/                      # Next.js server (API + dashboard + public trigger)
  app/
    layout.tsx            # root layout, imports globals.css
    page.tsx              # / redirects to /keys or /login
    globals.css           # Tailwind 4 entry
    login/                # paste-key form + server action
    logout/               # POST clears session cookie
    (app)/                # route group: auth-required pages share a nav layout
      keys/
        page.tsx          # list + disable/enable
        new/              # create form
        [id]/             # detail + hits + copy/delete
    api/keys/...        # authenticated CRUD
    api/api-keys/...      # authenticated key mgmt
    api/inbox/...         # dev inbox JSON
    c/[publicId]/         # the public trigger
    inbox/                # dev webhook capture + viewer
  db/                     # Drizzle schema + migrations
  lib/                    # auth, env, keys, notify, response, session, etc.
  instrumentation.ts      # boot hook: migrations + bootstrap
cli/                      # @mantis/cli — terminal client
  src/
    commands/             # one file per command
    lib/                  # api client, config (keychain), output
docker/
docker-compose.yml
drizzle.config.ts
postcss.config.mjs
```

## License

MIT License. See [`LICENSE`](./LICENSE).