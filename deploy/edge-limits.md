# Public edge limits

Mantis trigger URLs are intentionally public. Put coarse limits at the first
public edge so abusive traffic is dropped before it reaches Node, Postgres, or
the notification queue.

## Recommended baseline

Use these as starting values, then adjust for your traffic:

| Surface | Methods | URL limit | Body limit | Rate limit |
|---|---:|---:|---:|---:|
| `/c/*` | `GET`, `HEAD`, `POST` | 2 KB | 16 KB | 120/min/IP |
| `/status/*` | `GET`, `HEAD` | 1 KB | 0 | 240/min/IP |
| `/api/wallet/*` | Wallet methods | 4 KB | 64 KB | 120/min/IP |
| `/inbox*`, `/api/inbox` | dev only | 2 KB | 64 KB | private/dev only |

Notes:

- `/c/:public_id` only needs a short public ID and an optional short `src`
  query parameter. A 2 KB URI ceiling is generous.
- Mantis does not need request bodies on `/c/*`; `POST` is accepted only for
  clients that can only signal by POST.
- If you intentionally embed long attribution in query strings, raise the URL
  limit for `/c/*` and keep the app's storage caps in sync.
- Node's default HTTP request-header limit is 16 KiB. Railway's public proxy
  allows 32 KB combined headers. The app stores request fields with caps above
  the Node default so normal accepted traffic is preserved.

## Cloudflare Tunnel or Cloudflare in front of any host

Cloudflare is the cleanest place to enforce app-layer limits for public Mantis
URLs. Rules only apply when the DNS record is proxied through Cloudflare.

### Custom rule: reject oversized public URLs

Dashboard path:

1. Cloudflare dashboard -> your zone -> Security -> WAF -> Custom rules.
2. Create a rule named `mantis public URL limits`.
3. Expression:

```text
(
  starts_with(http.request.uri.path, "/c/")
  and len(http.request.uri) > 2048
)
or
(
  starts_with(http.request.uri.path, "/status/")
  and len(http.request.uri) > 1024
)
or
(
  starts_with(http.request.uri.path, "/api/wallet/")
  and len(http.request.uri) > 4096
)
or
(
  starts_with(http.request.uri.path, "/inbox")
  or starts_with(http.request.uri.path, "/api/inbox")
)
```

4. Action: `Block`.
5. Deploy.

If you changed `MANTIS_PUBLIC_PATH`, replace `/c/` with that path.

### Rate limiting rules

Dashboard path:

1. Security -> WAF -> Rate limiting rules.
2. Create one rule for `/c/*`:
   - Expression: `starts_with(http.request.uri.path, "/c/")`
   - Characteristics: IP address
   - Period: 60 seconds
   - Requests: 120
   - Mitigation timeout: 60 seconds
   - Action: Block or Managed Challenge
3. Create one rule for `/status/*`:
   - Expression: `starts_with(http.request.uri.path, "/status/")`
   - Characteristics: IP address
   - Period: 60 seconds
   - Requests: 240
   - Mitigation timeout: 60 seconds
   - Action: Block
4. If Apple Wallet is enabled, create one rule for `/api/wallet/*`:
   - Expression: `starts_with(http.request.uri.path, "/api/wallet/")`
   - Characteristics: IP address
   - Period: 60 seconds
   - Requests: 120
   - Mitigation timeout: 60 seconds
   - Action: Block

Request body-size matching with `http.request.body.size` is an Enterprise
feature. On Free/Pro/Business plans, enforce body size in an origin proxy
such as nginx/Caddy or rely on Mantis not reading `/c/*` bodies.

Cloudflare references:

- [Rules language functions](https://developers.cloudflare.com/ruleset-engine/rules-language/functions/)
- [Rate limiting rules](https://developers.cloudflare.com/waf/rate-limiting-rules/)
- [Request body size field](https://developers.cloudflare.com/ruleset-engine/rules-language/fields/reference/http.request.body.size/)

## Railway

Railway has useful network limits, but not an app-layer WAF. Railway documents
a 32 KB combined header limit, about 11,000 requests/sec per domain, and L4
DDoS mitigation; it explicitly recommends Cloudflare when you need WAF
functionality.

Recommended Railway setup:

1. Deploy Mantis on Railway as usual.
2. Add a custom domain in Railway.
3. Put that hostname in Cloudflare DNS with the orange cloud enabled.
4. Add the Cloudflare custom and rate limiting rules above.
5. Set `TRUST_PROXY_HEADERS=1` only when Cloudflare is the public entry point.

Without Cloudflare, keep `MANTIS_DUPLICATE_LOG_LIMIT` low and use hit
retention so known URLs cannot grow the database indefinitely.

Railway references:

- [Public networking specs and limits](https://docs.railway.com/networking/public-networking/specs-and-limits)
- [Pricing](https://docs.railway.com/pricing)
- [Redis service](https://docs.railway.com/guides/redis)

### Railway Redis/Valkey for shared rate limiting

Mantis does not require Redis/Valkey by default. Adding it on Railway means
running another always-on service. Based on Railway's current usage pricing:

- RAM is billed at $10/GB-month.
- CPU is billed at $20/vCPU-month by actual usage.
- Volume storage is $0.15/GB-month.
- Hobby has a $5/month minimum that counts toward usage.

A small Redis/Valkey limiter using 256 MB of RAM costs about $2.50/month in RAM
before CPU and storage. If your Mantis app plus Postgres are still under the
Hobby included usage, it may not change the bill; otherwise it adds a few
dollars per month. Performance is usually fine for a limiter, but every `/c/*`
hit adds a private-network round trip before the DB insert. Prefer Cloudflare
or provider edge limits first, then add Redis/Valkey only if you run multiple
Mantis replicas or need strict shared counters.

## Fly.io

Fly's `http_service.concurrency` protects each Machine from too many concurrent
requests, but it is not a per-IP rate limiter or WAF. The example
`deploy/fly.toml.example` already uses request-based concurrency.

Recommended Fly setup:

1. Keep `type = "requests"` with a hard limit your VM can actually handle.
2. Use a Cloudflare-proxied custom domain for the public hostname if the
   Mantis URL will be exposed broadly.
3. Add the Cloudflare rules above.

Fly reference:

- [Concurrency settings](https://fly.io/docs/apps/concurrency/)

## Render

Render provides DDoS protection automatically, but application-layer abuse is
still your responsibility. Use a Cloudflare-proxied custom domain if you need
per-path URL and rate limits before traffic reaches the service.

Render reference:

- [DDoS protection](https://render.com/docs/ddos-protection)

## Tailscale Funnel

Tailscale Funnel is convenient, but it is not a full WAF. Use split mode from
`deploy/tailscale.md` so only public routes are exposed, and keep dashboard/API
traffic on the private Serve hostname.

For stricter public limits with Tailscale:

1. Prefer Cloudflare Tunnel if you own a domain and want edge rules.
2. Or put nginx/Caddy between the Funnel sidecar and Mantis, then point
   Tailscale Serve/Funnel at that local proxy instead of `mantis:3000`.

Minimal nginx location shape:

```nginx
client_max_body_size 16k;
large_client_header_buffers 4 8k;

location /c/ {
  limit_except GET HEAD POST { deny all; }
  limit_req zone=mantis_trigger burst=20 nodelay;
  proxy_pass http://mantis:3000;
}

location /status/ {
  limit_except GET HEAD { deny all; }
  limit_req zone=mantis_status burst=20 nodelay;
  proxy_pass http://mantis:3000;
}
```

You would also need a matching `limit_req_zone` in nginx's `http` block. This
is intentionally not in the default compose file because it adds another moving
part for the common personal setup.

## Local Docker

The compose file binds Mantis to `127.0.0.1` by default. That is the best local
limit: no public edge exists. If you set `MANTIS_BIND_HOST=0.0.0.0`, put a
local reverse proxy in front before exposing it to untrusted networks.
