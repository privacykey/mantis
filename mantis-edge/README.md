# @mantis/edge

Stateless, encryption-only mantis variant. Runs as a single Cloudflare Worker. No database, no persistence — the webhook destination is encrypted into the URL itself, the worker decrypts on each hit and forwards the request metadata. Pure RAM, ~10MB footprint, fits comfortably in Cloudflare's free tier.

## When to use this vs. stateful mantis

| | Stateful (root project) | Edge (this) |
|---|---|---|
| Dashboard / hit history | ✓ | ✗ — webhook is the audit log |
| File / folder / installer keys | ✓ | ✓ (the URL is just an opaque string they embed) |
| Dedupe (60s window) | ✓ | ✗ |
| Disable a single key | ✓ | ✗ — only "revoke all" by rotating `MANTIS_EDGE_KEY` |
| Uptime Kuma latch/window monitoring | ✓ | ✗ |
| Postgres required | ✓ | ✗ |
| Horizontal scaling | bounded by DB | ∞ |
| Cost to run | postgres + app | free tier on Workers |

You can run both side-by-side: stateful mantis for keys you want to manage, edge for high-volume / ephemeral / red-team-window-bounded ones.

## Wire format

```
URL:        https://<worker>/c/<blob>
blob:       base64url( version || nonce || ciphertext || tag )
              ↳ 1 byte ver (0x01), 12 byte nonce, N byte ct, 16 byte GCM tag
plaintext:  { "w": "<webhook>", "r": "gif", "p": {...}, "m": "memo", "exp": 1735689600 }
```

| Field | Required | Notes |
|---|---|---|
| `w` | yes | webhook URL (http/https). If `MANTIS_EDGE_WEBHOOK_ALLOWLIST` is set, the hostname must match it. |
| `r` | no | response kind: `gif` (default) / `empty` / `json` / `redirect` / `html` |
| `p` | no | response payload (for json/redirect/html) |
| `m` | no | memo string, forwarded to webhook for context |
| `exp` | no | unix seconds; URL returns 404 after this time |

AES-256-GCM gives confidentiality + integrity. Tamper any byte → decrypt throws → worker returns 404. Wrong key → same. The worker leaks nothing about the format on failure.

## Deploy

Prereqs:

- **A Cloudflare account with Workers enabled** (the free tier is fine).
- **The mantis CLI**, which provides the `mantis edge *` commands used below. Install it globally with `npm i -g @mantis/cli` (or `brew install mantis`). The CLI is all you need to *mint* and *manage* edge URLs against an already-deployed worker.
- **Only to deploy the worker from source:** `cd mantis-edge && npm install`. Wrangler is bundled as a dev dependency, so this installs it locally and the snippets below invoke it via `npx wrangler` — no global wrangler install needed.
- **Cloudflare auth for wrangler.** Run `npx wrangler login` once; the first wrangler command opens a browser to authorize against your account. For CI / headless environments where no browser is available, set the `CLOUDFLARE_API_TOKEN` env var (a Workers-scoped API token) instead of logging in interactively.

See [deploy.md](./deploy.md) for custom domains, CI deploys, allowlisting, local dev, and verification. The short path:

```bash
cd mantis-edge
npm install
npx wrangler login   # one-time; opens a browser. CI: set CLOUDFLARE_API_TOKEN instead.

# 1. Generate the encryption key
mantis edge keygen
# → prints a base64url key on stdout, save it
# → also prints the next commands to stderr

# 2. Deploy. This creates the worker on your account and prints its URL.
mantis edge deploy   # wraps `wrangler deploy` and captures the *.workers.dev URL for you
# → or run `npx wrangler deploy` directly
# → prints your worker URL, e.g. https://mantis-edge.<your-subdomain>.workers.dev

# 3. Set the encryption key on the (now-existing) worker as a secret.
# Wrangler prompts: paste the base64url key that `mantis edge keygen` just printed.
npx wrangler secret put MANTIS_EDGE_KEY

# 4. Optional defense-in-depth: restrict where edge URLs can POST.
# When wrangler prompts, paste a comma-separated allowlist
# (e.g. hooks.slack.com,discord.com,*.example.com).
npx wrangler secret put MANTIS_EDGE_WEBHOOK_ALLOWLIST

# Setting a secret takes effect on the next request without a redeploy. If you
# changed wrangler.toml (e.g. added routes), run `npx wrangler deploy` again.

# 5. Save the same key locally so the CLI can mint URLs against it.
# This prompts for the key — paste the value from `mantis edge keygen` again.
mantis edge set-key https://mantis-edge.<your-subdomain>.workers.dev
```

For local dev:

```bash
cp .dev.vars.example .dev.vars
# paste the key into .dev.vars
npm run dev
# → wrangler dev on http://localhost:8787
```

## Mint an edge URL

The fastest path is the **interactive wizard**: run `mantis edge mint` bare in a terminal and it walks you through worker → installer → channel → webhook → test → memo, with a summary + per-field edit at the end.

```text
$ mantis edge mint

  Worker URL [https://mantis-edge.<sub>.workers.dev]:
  Generate installer snippet? [y/N]: y
    Installer type [shell]:
    SSH-only guard? [y/N]: y
    Write to file (blank = print to stdout): ~/.zshrc.d/mantis.sh
    → trigger response defaulting to `empty` (suitable for shell)
  Notification channel (webhook / slack / discord / teams) [webhook]: discord
  Discord webhook URL: https://discord.com/api/webhooks/.../...
  Test fire after mint? [Y/n]:
  Memo (optional, shown in notifications): ssh on prod-bastion

Summary:
  worker     https://mantis-edge.<sub>.workers.dev
  installer  shell ssh-only → ~/.zshrc.d/mantis.sh
  response   empty
  channel    discord
  webhook    https://discord.com/api/webhooks/.../...
  test       yes
  memo       ssh on prod-bastion

Proceed? [Y/n/edit]:
```

The wizard only kicks in when stdin is a TTY and required flags are missing, so **scripts and CI never see a prompt**. Any flag you pre-set skips its prompt. Full non-interactive form:

```bash
mantis edge mint \
  --worker https://mantis-edge.<sub>.workers.dev \
  --webhook https://hooks.slack.com/services/... \
  --channel slack \
  --memo "prod-bastion shell" \
  --response-kind gif \
  --test

# → https://mantis-edge.<sub>.workers.dev/c/<encrypted-blob>
# length: 220
# ✓ test: worker accepted the URL (HTTP 200) and queued the webhook.
```

`--test` fires a single GET against the URL right after mint and reports the worker's response, so you find out about misconfigurations (wrong key, allowlist blocked, channel mismatch) before handing the URL off. It's opt-in — omit it for clean scripted use.

## Generate an installer for a minted URL

`mantis edge install <url> --type <type>` (or the chained `mantis edge mint --install <type> --out FILE`) produces the same kinds of installer snippets `mantis install <key-id>` does on the stateful server, but works against a stateless edge URL — no DB, no server round-trip.

```bash
# Standalone — when you already have a URL
mantis edge install "$EDGE_URL" --type shell --ssh-only --out ~/.zshrc.d/mantis.sh

# Chained — mint and install in one go
mantis edge mint \
  --worker https://mantis-edge.<sub>.workers.dev \
  --webhook https://discord.com/api/webhooks/.../... \
  --channel discord \
  --memo "ssh on $(hostname -s)" \
  --install shell \
  --ssh-only \
  --out ~/.zshrc.d/mantis.sh \
  --test
```

All 18 installer types from the stateful CLI work here verbatim: `shell`, `shell-sudo`, `macos-{login,boot,wake,network}`, `linux-{boot,wake,network}`, `windows-{logon,wake,network}`, `css-background`, `js-clone-detector` (needs `--hostname`), `nfc-ndef`, `homeassistant`, `homeassistant-receiver`, `scrypted`. The default trigger response is auto-set per installer (`empty` for back-channel curls, `gif` for browser-facing CSS/NFC) and can be overridden via `--response-kind` or the wizard's edit step.

Trigger manually any time after:

```bash
curl -i https://mantis-edge.<sub>.workers.dev/c/<blob>
# → 200, 1×1 transparent GIF
# → webhook fires in the background, formatted for the chosen channel
```

## Destination channels

`--channel` (encrypted into the URL alongside the webhook target) selects how the worker formats the body it POSTs to your webhook:

| `--channel` | Payload shape | Use for |
|---|---|---|
| `webhook` *(default)* | Mantis `mantis.hit` JSON (same as stateful server, with `key.id`/`public_id` null) | Your own receiver / Pipedream / n8n / webhook.site |
| `slack` | Slack `blocks` message with header + section + fields | Slack incoming webhooks (`hooks.slack.com/services/...`) |
| `discord` | Discord embed with title, fields, timestamp | Discord webhooks (`discord.com/api/webhooks/...`) |
| `teams` | Microsoft Teams Adaptive Card (Power Automate workflow webhook) | Teams workflow webhooks |

The channel is baked into the encrypted blob at mint time — the worker doesn't have to know in advance which channel a given URL targets, and the same worker can serve URLs minted for all four channels simultaneously.

## Raw webhook payload shape

`--channel webhook` (or omitting `--channel`) sends Mantis's structured hit payload, matching the stateful mantis's webhook body with `key.id` / `key.public_id` set to `null` (stateless mode has no stored key row):

```json
{
  "type": "mantis.hit",
  "key": {
    "id": null,
    "public_id": null,
    "memo": "prod-bastion shell",
    "url": "https://mantis-edge.<sub>.workers.dev/c/<blob>"
  },
  "hit": {
    "id": "<random uuid per hit>",
    "occurred_at": "2026-05-13T10:00:00.000Z",
    "ip": "203.0.113.5",
    "user_agent": "...",
    "referer": null,
    "ua_browser": null,
    "ua_browser_version": null,
    "ua_os": null,
    "ua_device": null,
    "bot_label": null,
    "is_duplicate": false,
    "host_context": { ... },
    "headers": { ... }
  }
}
```

UA-parsing and bot-detection are skipped on the worker (keep it minimal). The receiving webhook can parse headers itself if it wants enrichment.

`host_context` is populated from `X-Mantis-*` headers exactly as in the stateful version, so the existing installers (shell / macOS / Linux / Windows / web embeds) work with no changes — just point them at the edge URL.

## Limits and tradeoffs

- **Key rotation = mass revocation.** Changing `MANTIS_EDGE_KEY` invalidates *every* outstanding edge URL. Plan rotations.
- **URL length.** A Slack webhook URL is ~95 chars; encrypted edge URL ends up ~200–240 chars total. Fine for most uses but visibly long.
- **Open-redirect / response-kind=`redirect`.** The redirect URL is taken from `payload.p.url`. Anyone who can mint URLs (= holds the key) can mint a redirect to anywhere. The key is the security boundary.
- **No mint endpoint on the worker.** Minting is strictly client-side. A compromised worker can forward existing URLs but can't mint new ones — only the key holder can.
- **`exp` is advisory.** Once a URL is minted, the only way to revoke it before `exp` is to rotate the key.
- **Webhook allowlisting is optional.** Set `MANTIS_EDGE_WEBHOOK_ALLOWLIST` to exact hosts or wildcards to reduce blast radius if the edge key leaks. Examples: `hooks.slack.com`, `discord.com`, `*.example.com`.

## Files

```
src/
  index.ts         # fetch handler: parse, unseal, forward, respond
  seal.ts          # AES-256-GCM seal/unseal + base64url
  forward.ts       # POST to payload.w with mantis.hit JSON shape
  response.ts      # gif / empty / json / redirect / html
  host-context.ts  # parses X-Mantis-* headers (matches stateful version)
  types.ts         # shared types
wrangler.toml      # Cloudflare Worker config
```
