# @mantis/edge

Stateless, encryption-only mantis variant. Runs as a single Cloudflare Worker. No database, no persistence — the webhook destination is encrypted into the URL itself, the worker decrypts on each hit and forwards the request metadata. Pure RAM, ~10MB footprint. It runs on the Workers Free plan, but that plan has a daily request cap that can silence every edge canary at once — read [Platform request quota](#platform-request-quota) before you rely on it.

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
| Cost to run | postgres + app | Workers Free works; Workers Paid for anything you rely on ([why](#platform-request-quota)) |

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

- **A Cloudflare account with Workers enabled.** The Free plan is enough to try it; see [Platform request quota](#platform-request-quota) before relying on it for real alerts.
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

**Chat alerts never contain the edge URL.** Slack, Discord and Teams alerts identify the URL that fired as inert text — `Edge canary AQx1Yz-aB3… on mantis-edge.<sub>.workers.dev` — the worker's host plus the first 10 characters of the sealed blob, which you can match against the URLs you minted. There is deliberately no link: the URL *is* the trigger and the worker keeps no state, so a click on the alert, a link preview, or a mail/chat security scanner following the link would fire the canary again and post another alert with the same link. The fragment is far too short to decrypt, so nothing built from it can fire anything.

Values the caller controls (`X-Mantis-*` host context, IP, User-Agent) are escaped and then cut to a short display budget, so an oversized header cannot push a field past Slack's or Discord's length limits and get the whole alert rejected. The raw `webhook` channel still carries the full values.

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

`key.url` is the full edge URL as it was requested — machine data, kept so a receiver can tell which URL fired. It is still the live trigger. If your receiver relays alerts into chat, email or a ticket, do not render `key.url` as a link (or at all): anything that fetches it fires the canary again.

`host_context` is populated from `X-Mantis-*` headers exactly as in the stateful version, so the existing installers (shell / macOS / Linux / Windows / web embeds) work with no changes — just point them at the edge URL.

## Limits and tradeoffs

- **Key rotation = mass revocation.** Changing `MANTIS_EDGE_KEY` invalidates *every* outstanding edge URL. Plan rotations.
- **URL length.** A Slack webhook URL is ~95 chars; encrypted edge URL ends up ~200–240 chars total. Fine for most uses but visibly long.
- **Open-redirect / response-kind=`redirect`.** The redirect URL is taken from `payload.p.url`. Anyone who can mint URLs (= holds the key) can mint a redirect to anywhere. The key is the security boundary.
- **No mint endpoint on the worker.** Minting is strictly client-side. A compromised worker can forward existing URLs but can't mint new ones — only the key holder can.
- **`exp` is advisory.** Once a URL is minted, the only way to revoke it before `exp` is to rotate the key.
- **Webhook allowlisting is optional.** Set `MANTIS_EDGE_WEBHOOK_ALLOWLIST` to exact hosts or wildcards to reduce blast radius if the edge key leaks. Examples: `hooks.slack.com`, `discord.com`, `*.example.com`.
- **Every fetch is a hit.** There is no dedupe window and no per-URL or per-IP limiter: every request to an edge URL, with any HTTP method, forwards one alert. Do not paste an edge URL into a chat, ticket or email that previews or scans links.
- **Delivery is best-effort, with a short retry.** A forward that fails with `429`, a `5xx`, a network error or a timeout is retried up to twice (backoff of about 0.5 s then 1 s, or the destination's `Retry-After` when it is 5 s or less), all inside the roughly 30 s Cloudflare lets a Worker keep working after it has answered. After that the alert is dropped and only logged (`npx wrangler tail`, look for `mantis-edge webhook forward failed`) — the worker has nowhere to queue it. A destination that asks for a longer `Retry-After` is not retried.
- **One flooded URL can cost you other alerts.** Anyone who holds one edge URL can request it as often as they like, and each request is one POST to its webhook. Chat providers rate-limit per webhook, and `mantis edge device` seals the *same* webhook into every vector's URL, so a flood of one URL can use up the budget the others need; the retry above only bridges a short rejection window. If that matters: give the canaries you care most about their own webhook, and put the worker on a custom domain with a rate-limiting rule (below).

### Platform request quota

On the **Workers Free** plan Cloudflare caps an account at **100,000 Worker requests per day**, counted across every Worker on the account and reset at 00:00 UTC (check [Cloudflare's limits page](https://developers.cloudflare.com/workers/platform/limits/) for the current figure). Every request to the worker's hostname counts, including junk that the worker answers with `404` — any path, any method, or a `/c/<blob>` that does not decrypt.

Once the cap is reached **the worker is no longer invoked**: Cloudflare answers with its own error page (or bypasses the worker, depending on the route's failure mode) until the reset. Nothing is forwarded, nothing is logged by the worker, and **every edge canary on that account is silent**. The hostname is in every edge URL, so anyone who has seen one URL can spend the quota without ever firing a canary, and nothing in mantis-edge will tell you it happened.

The worker cannot defend itself — the request is counted before the code runs. What you can do:

- **Use Workers Paid** for canaries you rely on. There is no daily cap; excess traffic becomes billed requests instead of an outage. Turn on Cloudflare's usage/billing notifications so a flood is something you hear about.
- **Serve the worker from a custom domain** (see [deploy.md](./deploy.md#request-quota-rate-limiting-and-a-heartbeat)) and add a WAF rate-limiting rule for the hostname, plus a custom rule that blocks every path that does not start with `/c/`. A request blocked by a zone rule never reaches the worker. Two caveats: a `*.workers.dev` hostname is not part of any zone, so **zone WAF and rate-limiting rules cannot protect it** — set `workers_dev = false` in `wrangler.toml` once your URLs use the custom domain, or the unprotected hostname keeps reaching the same worker. And a per-IP limit does not stop a distributed flood, while random `/c/<blob>` paths look exactly like real ones, so this narrows the problem rather than closing it.
- **Run an external heartbeat.** Mint one dedicated edge URL whose webhook is a dead-man's-switch monitor — a healthchecks.io check or an Uptime Kuma *push* monitor, for example — and have something outside Cloudflare (cron on a server, an uptime service) request that URL every few minutes. The monitor alarms when the pings stop, which is how you find out that the worker has stopped being invoked for any reason: quota, a bad deploy, a rotated key. If you use `MANTIS_EDGE_WEBHOOK_ALLOWLIST`, add the monitor's host to it.

## Files

```
src/
  index.ts         # fetch handler: parse, unseal, forward, respond
  seal.ts          # AES-256-GCM seal/unseal + base64url
  forward.ts       # POST to payload.w (raw mantis.hit JSON or a chat format), bounded retry
  escape.ts        # escaping + length budgets for chat alerts, inert URL label
  private-host.ts  # blocks literal private / loopback / metadata webhook hosts
  response.ts      # gif / empty / json / redirect / html
  host-context.ts  # parses X-Mantis-* headers (matches stateful version)
  types.ts         # shared types
wrangler.toml      # Cloudflare Worker config
```
