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

Prereq: a Cloudflare account, `wrangler` (installed via `npm install` below), the mantis CLI (one directory up at `cli/`).

See [deploy.md](./deploy.md) for custom domains, CI deploys, allowlisting, local dev, and verification. The short path:

```bash
cd mantis-edge
npm install

# 1. Generate the encryption key
mantis edge keygen
# → prints a base64url key on stdout, save it
# → also prints the two next commands to stderr

# 2. Set it on the worker as a secret
wrangler secret put MANTIS_EDGE_KEY
# (paste the key when prompted)

# Optional defense-in-depth: restrict where edge URLs can POST.
wrangler secret put MANTIS_EDGE_WEBHOOK_ALLOWLIST
# e.g. hooks.slack.com,discord.com,*.example.com

# 3. Deploy
wrangler deploy
# → prints your worker URL, e.g. https://mantis-edge.<your-subdomain>.workers.dev

# 4. Save the key locally so the CLI can mint URLs against it
mantis edge set-key \
  --worker https://mantis-edge.<your-subdomain>.workers.dev \
  --key <paste>
```

For local dev:

```bash
cp .dev.vars.example .dev.vars
# paste the key into .dev.vars
npm run dev
# → wrangler dev on http://localhost:8787
```

## Mint an edge URL

```bash
mantis edge mint \
  --worker https://mantis-edge.<sub>.workers.dev \
  --webhook https://hooks.slack.com/services/... \
  --memo "prod-bastion shell" \
  --response-kind gif

# → https://mantis-edge.<sub>.workers.dev/c/<encrypted-blob>
```

Trigger it:

```bash
curl -i https://mantis-edge.<sub>.workers.dev/c/<blob>
# → 200, 1×1 transparent GIF
# → webhook fires in the background with the mantis.hit payload
```

## Forwarded webhook shape

Identical to the stateful mantis's webhook payload, with `key.id` / `key.public_id` set to `null` (stateless mode has no stored key row):

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
