# Deploying @mantis/edge

The short path lives in the [README](./README.md#deploy). This page covers the
deferred details: Cloudflare auth, custom domains, CI / headless deploys,
webhook allowlisting, local dev, and verification.

## Cloudflare auth

Wrangler needs to authenticate against a Cloudflare account that has Workers
enabled. The Free plan is enough to try it out; read
[Request quota, rate limiting and a heartbeat](#request-quota-rate-limiting-and-a-heartbeat)
before relying on it for real alerts.

- **Interactive (laptop):** run `npx wrangler login` once. The first wrangler
  command opens a browser to authorize; the token is cached locally afterwards.
- **CI / headless:** there's no browser, so skip `wrangler login` and set the
  `CLOUDFLARE_API_TOKEN` env var to a Workers-scoped API token. Wrangler picks
  it up automatically. Create the token in the Cloudflare dashboard under *My
  Profile → API Tokens* with the *Edit Cloudflare Workers* template.

```bash
# CI deploy — no interactive login
export CLOUDFLARE_API_TOKEN="<workers-scoped-token>"
npx wrangler deploy
```

Set worker secrets the same way you would locally — `wrangler secret put` reads
from stdin, so a pipeline can feed the value non-interactively:

```bash
printf '%s' "$MANTIS_EDGE_KEY" | npx wrangler secret put MANTIS_EDGE_KEY
```

## Custom domains

By default the worker is reachable at `https://mantis-edge.<your-subdomain>.workers.dev`.
To serve it from your own domain, add a route to `wrangler.toml` for a zone you
control on Cloudflare, then redeploy. The template is already in the file,
commented out:

```toml
# Custom domain (optional). Replace with your own zone, or delete this section
# and use the default *.workers.dev URL.
[[routes]]
pattern = "mantis-edge.example.com/*"
zone_name = "example.com"
```

```bash
npx wrangler deploy   # routes in wrangler.toml take effect on deploy
```

Point `mantis edge set-key` (and any minted URLs) at the custom domain once the
route is live. Editing routes is a `wrangler.toml` change, so it requires a
redeploy — unlike secrets, which take effect on the next request.

## Request quota, rate limiting and a heartbeat

The worker is reachable by anyone who knows its hostname, and the hostname is
in every edge URL. Two things follow.

**Workers Free has a daily request cap.** At the time of writing it is 100,000
requests per day for the whole account, reset at 00:00 UTC (see
[Cloudflare's limits](https://developers.cloudflare.com/workers/platform/limits/)).
Every request counts, including junk the worker answers with `404`. When the
cap is reached Cloudflare stops invoking the worker until the reset, so every
edge canary on the account goes silent — with no alert and no worker log line.
Workers Paid has no daily cap: a flood becomes billed requests instead of an
outage, so enable usage notifications in the Cloudflare dashboard.

**`*.workers.dev` cannot be put behind zone rules.** WAF custom rules and
rate-limiting rules belong to a zone, and the default hostname is not in one.
To get them:

1. Add the `[[routes]]` block above for a hostname on a zone you control, and
   deploy.
2. In that zone, add a rate-limiting rule for the hostname (Security → WAF →
   Rate limiting rules) — for example, block an IP that makes more than a few
   dozen requests in 10 seconds — and a custom rule that blocks any request
   whose path does not start with `/c/`. Requests blocked there never reach
   the worker.
3. Re-point your URLs: the sealed blob does not depend on the hostname, so an
   existing URL keeps working with the host swapped for the custom domain.
   Update `mantis edge set-key` and every installed URL.
4. Then set `workers_dev = false` in `wrangler.toml` and deploy again.
   Otherwise the unprotected `*.workers.dev` hostname still reaches the same
   worker (and the same quota). URLs that still use it stop working at this
   point — which is why step 3 comes first.

A per-IP rule does not stop a distributed flood, and a random `/c/<blob>`
cannot be told apart from a real URL without the key, so treat this as raising
the cost, not as a guarantee.

**Monitor it from outside.** Nothing in the worker can report that the worker
is not running. Mint one edge URL whose webhook is a dead-man's-switch monitor
(a healthchecks.io check, an Uptime Kuma push monitor, …), and have cron or an
uptime service request it every few minutes:

```bash
mantis edge mint \
  --worker https://mantis-edge.example.com \
  --webhook https://hc-ping.com/<your-check-uuid> \
  --response-kind empty \
  --memo "edge heartbeat"
# then, from a machine outside Cloudflare:
#   */5 * * * *  curl -fsS -m 10 -o /dev/null "<the minted URL>"
```

The monitor alarms when the pings stop arriving — quota exhausted, a broken
deploy, a rotated `MANTIS_EDGE_KEY`. If you set
`MANTIS_EDGE_WEBHOOK_ALLOWLIST`, include the monitor's host.

## Webhook allowlisting

`MANTIS_EDGE_WEBHOOK_ALLOWLIST` is an optional defense-in-depth secret. When
set, the worker only forwards to webhook hosts that match it; everything else
gets a 404. It limits the blast radius if the edge key leaks — a key holder can
still mint URLs, but only to hosts you've pre-approved.

```bash
# When wrangler prompts, paste a comma-separated list of exact hosts or
# wildcards, e.g. hooks.slack.com,discord.com,*.example.com
npx wrangler secret put MANTIS_EDGE_WEBHOOK_ALLOWLIST
```

For local dev, set it in `.dev.vars` instead (see `.dev.vars.example`).

## Local dev

```bash
cp .dev.vars.example .dev.vars
# paste the base64url key from `mantis edge keygen` into .dev.vars
npm run dev
# → wrangler dev on http://localhost:8787
```

`wrangler dev` reads `MANTIS_EDGE_KEY` (and the optional allowlist) from
`.dev.vars`, not from the deployed worker's secrets, so you can iterate without
touching production.

## Verify

After deploying, mint a URL with `--test` so the CLI fires one GET against the
worker and reports the result:

```bash
mantis edge mint \
  --worker https://mantis-edge.<sub>.workers.dev \
  --webhook https://hooks.slack.com/services/... \
  --channel slack \
  --test
```

A misconfiguration (wrong key, allowlist blocked, channel mismatch) surfaces
here rather than the first time the URL is hit in the wild. You can also curl a
minted URL directly:

```bash
curl -i https://mantis-edge.<sub>.workers.dev/c/<blob>
# → 200, 1×1 transparent GIF, and the webhook fires in the background
```
