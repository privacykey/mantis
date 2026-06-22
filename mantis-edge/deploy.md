# Deploying @mantis/edge

The short path lives in the [README](./README.md#deploy). This page covers the
deferred details: Cloudflare auth, custom domains, CI / headless deploys,
webhook allowlisting, local dev, and verification.

## Cloudflare auth

Wrangler needs to authenticate against a Cloudflare account that has Workers
enabled (the free tier is fine).

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
