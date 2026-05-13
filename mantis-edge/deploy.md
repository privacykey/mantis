# Deploying mantis-edge

This guide covers the Cloudflare Worker version of mantis. It has no database and no dashboard: the encrypted URL contains the webhook destination, and the webhook receiver becomes the audit log.

## Prerequisites

- A Cloudflare account with Workers enabled.
- Node 24 or newer.
- The mantis CLI from `../cli`, linked or runnable from this repo.

```bash
cd mantis-edge
npm install
```

## 1. Generate and store the edge key

Generate one 32-byte base64url key:

```bash
mantis edge keygen
```

Set it as a Worker secret:

```bash
wrangler secret put MANTIS_EDGE_KEY
```

Save the same key locally so the CLI can mint URLs:

```bash
mantis edge set-key \
  --worker https://mantis-edge.<your-subdomain>.workers.dev \
  --key <paste-key>
```

The key is the minting authority. Anyone with it can create valid edge URLs, so keep it in the OS keychain via the CLI and avoid putting it in shell history or CI logs.

## 2. Restrict webhook destinations

For defense-in-depth, set an optional comma-separated allowlist:

```bash
wrangler secret put MANTIS_EDGE_WEBHOOK_ALLOWLIST
```

Examples:

```text
hooks.slack.com,discord.com,*.example.com
```

Rules are hostname-only:

- `hooks.slack.com` matches exactly `hooks.slack.com`.
- `*.example.com` matches subdomains like `alerts.example.com`, but not `example.com`.
- Full URLs are accepted in the setting, but only their hostname is used.

When the allowlist is set, encrypted URLs with non-matching webhook hosts return the same `404` as invalid URLs. The Worker logs a sanitized host-only message for the operator.

## 3. Deploy

```bash
wrangler deploy
```

Wrangler prints the deployed Worker URL, usually:

```text
https://mantis-edge.<your-subdomain>.workers.dev
```

If you use a custom domain, add a route in `wrangler.toml`:

```toml
[[routes]]
pattern = "edge.example.com/*"
zone_name = "example.com"
```

Then deploy again and store the custom URL locally:

```bash
mantis edge set-key --worker https://edge.example.com --key <paste-key>
mantis profile set-edge prod --worker https://edge.example.com
```

## 4. Verify

Mint a URL that posts to a test webhook:

```bash
mantis edge mint \
  --worker https://edge.example.com \
  --webhook https://hooks.slack.com/services/... \
  --memo "edge smoke test"
```

Trigger it:

```bash
curl -i "https://edge.example.com/c/<encrypted-blob>"
```

Expected:

- The HTTP response matches the minted response kind, usually `200 image/gif`.
- The webhook receives a `mantis.hit` payload.
- Cloudflare Worker logs stay quiet on success.

For failure debugging:

```bash
wrangler tail
```

Webhook failures are logged with the target origin only, not the full webhook path or query.

## 5. Local development

```bash
cp .dev.vars.example .dev.vars
# Fill MANTIS_EDGE_KEY and optional MANTIS_EDGE_WEBHOOK_ALLOWLIST.
npm run dev
```

Wrangler serves the Worker at:

```text
http://localhost:8787
```

Store the local worker URL if you want to mint against it:

```bash
mantis edge set-key --worker http://localhost:8787 --key <paste-key>
mantis edge mint --worker http://localhost:8787 --webhook http://localhost:3000/inbox/edge
```

## 6. CI deploys

Use Cloudflare's API token support for CI:

```bash
CLOUDFLARE_API_TOKEN=<token> npm run deploy
```

Set Worker secrets outside the deploy command. For hosted CI, prefer Cloudflare dashboard secrets or a one-time setup step:

```bash
printf '%s' "$MANTIS_EDGE_KEY" | wrangler secret put MANTIS_EDGE_KEY
printf '%s' "$MANTIS_EDGE_WEBHOOK_ALLOWLIST" | wrangler secret put MANTIS_EDGE_WEBHOOK_ALLOWLIST
```

Keep the minting key out of repository variables that broad groups can read.

## 7. Rotation

Rotating `MANTIS_EDGE_KEY` immediately invalidates all existing edge URLs. A practical rotation:

1. Generate a new key with `mantis edge keygen`.
2. Update the Worker secret with `wrangler secret put MANTIS_EDGE_KEY`.
3. Update the local CLI key with `mantis edge set-key --worker <url> --key <new-key>`.
4. Re-mint any URLs that should keep working.

Use `--expires-at` when minting short-lived URLs so old URLs naturally age out.
