# Deploying mantis with Tailscale

This sets up mantis to run in Docker on your own hardware (laptop, home
server, NAS, VPS) and expose it through Tailscale. There are two useful modes:

| Mode | Public internet | Tailnet-only | Best for |
|---|---|---|---|
| Simple Funnel | Whole app | Same URL | Personal installs where mantis API-key auth is enough |
| Split Serve + Funnel | `/c/*`, `/status/*`, `/api/wallet/*` | Dashboard + `/api/*` | Keeping sensitive dashboard/API routes off the public internet |

The split mode is closest to the Cloudflare Access posture: public tripwires
keep working, while management traffic only works from your tailnet.

## Prerequisites

- Docker + Docker Compose.
- A [Tailscale](https://tailscale.com) account.
- A reusable Tailscale auth key. Split mode starts two Tailscale nodes, so a
  one-use key will register only the first one.

## Step 1 — One-time tailnet configuration

These settings live in the [Tailscale admin console](https://login.tailscale.com/admin)
and only need to be done once per tailnet.

1. **Enable HTTPS Certificates** — `DNS` → **Enable HTTPS**. This lets Tailscale
   issue certificates for `*.<tailnet>.ts.net`.
2. **Enable Funnel** — `Funnel` → **Enable Funnel for this tailnet**. Without
   this, Funnel config is ignored and the public hostname is tailnet-only.
3. **If you use ACLs**, add a tag owner so the Docker nodes can register tagged:

   ```json
   "tagOwners": {
     "tag:mantis": ["autogroup:admin"]
   }
   ```

## Step 2 — Generate an auth key

Go to **Settings → Keys → Generate auth key** with these properties:

| Setting | Recommended | Why |
|---|---|---|
| Reusable | Yes | Needed for split mode's two Tailscale containers |
| Ephemeral | Yes | Container restarts clean up old node entries |
| Pre-approved | Yes | Avoids manual approval every compose recreate |
| Tags | `tag:mantis` | Optional, useful for ACLs |
| Expiry | 90 days | Tailscale's usual max for auth keys |

Copy the `tskey-auth-...` value.

## Option A — Simple Funnel

This is the existing one-host setup. It exposes the whole app publicly through
Funnel; dashboard and API routes still require mantis auth.

```bash
cp .env.example .env
# Edit .env:
#   TS_AUTHKEY=tskey-auth-xxxxxxxxxxxx
#   TS_HOSTNAME=mantis
#   PUBLIC_BASE_URL=https://mantis.<your-tailnet>.ts.net

docker compose --profile tailscale up -d
```

Verify:

```bash
docker compose logs tailscale | grep -E "Success|funnel"
curl -i https://mantis.<your-tailnet>.ts.net/status/nonexistent
```

## Option B — Split Serve + Funnel

This is the recommended Tailscale posture when you want `/api/*` and the
dashboard off the public internet.

It starts two Tailscale sidecars:

- `mantis-private.<tailnet>.ts.net` uses Tailscale Serve only. This is where
  you open the dashboard and point the CLI.
- `mantis-public.<tailnet>.ts.net` uses Tailscale Funnel. Mantis allows only
  public routes on this host: `/c/*`, `/status/*`, and `/api/wallet/*`.

Configure `.env`:

```bash
TS_AUTHKEY=tskey-auth-xxxxxxxxxxxx
TS_PRIVATE_HOSTNAME=mantis-private
TS_PUBLIC_HOSTNAME=mantis-public
TS_EXTRA_ARGS=--advertise-tags=tag:mantis

# Generated trigger/status/wallet URLs should be public.
PUBLIC_BASE_URL=https://mantis-public.<your-tailnet>.ts.net

# This host is public-only. Dashboard and management API paths return 404 here.
PUBLIC_ONLY_HOSTS=mantis-public.<your-tailnet>.ts.net

# This host is allowed to serve the dashboard and management API.
DASHBOARD_HOSTS=mantis-private.<your-tailnet>.ts.net

# Usually useful behind Tailscale's proxy so hit logs show client IPs.
TRUST_PROXY_HEADERS=1
```

Start it:

```bash
docker compose --profile tailscale-split up -d
```

Verify public behavior from a non-tailnet network, for example a phone on
cellular:

```bash
curl -i https://mantis-public.<your-tailnet>.ts.net/status/nonexistent
curl -i https://mantis-public.<your-tailnet>.ts.net/login
curl -i https://mantis-public.<your-tailnet>.ts.net/api/keys
```

Expected:

- `/status/nonexistent` reaches mantis and returns `404 not_monitored`.
- `/login` returns a plain `404`.
- `/api/keys` returns a plain `404`, not a mantis auth challenge.

Verify private behavior from a device on your tailnet:

```bash
open https://mantis-private.<your-tailnet>.ts.net/login
mantis login --url https://mantis-private.<your-tailnet>.ts.net
mantis list
mantis doctor --public-url https://mantis-public.<your-tailnet>.ts.net
```

Use the private hostname for dashboard and CLI. Use the public hostname for
generated mantis trigger/status URLs; `PUBLIC_BASE_URL` already handles that.
`mantis doctor` verifies the private API, then checks the public hostname hides
`/login` and `/api/*` while leaving `/status/*` reachable.

## Public edge limits

Tailscale Funnel is not a full application-layer WAF. Split mode is the main
protection: only `/c/*`, `/status/*`, and `/api/wallet/*` should be reachable
on the public Funnel hostname.

If the public hostname will be widely exposed or advertised, use one of these:

- Prefer Cloudflare Tunnel instead of Funnel when you own a domain and want
  per-path URL and rate limiting rules.
- Or put nginx/Caddy between Tailscale and Mantis, then point the Tailscale
  Serve/Funnel config at that proxy.

Suggested limits and a minimal nginx shape are in
[`deploy/edge-limits.md`](./edge-limits.md#tailscale-funnel).

### Optional public routes

The public-only guard is deliberately tight. These are opt-in:

```bash
# Public load balancer / uptime probes against /api/health.
PUBLIC_ONLY_ALLOW_HEALTH=1

# Dev-only webhook inbox routes. Leave off in production.
ENABLE_DEV_INBOX=1
PUBLIC_ONLY_ALLOW_INBOX=1
```

## Gotchas

- **Funnel is public, Serve is private.** Tailscale Serve can identify tailnet
  users and obeys tailnet ACLs; Funnel is for unauthenticated public internet
  exposure. The split setup uses both.
- **One port cannot be both private and public on one Tailscale node.** That is
  why split mode uses two Tailscale containers and two hostnames.
- **Funnel hostnames are `*.ts.net`.** Tailscale Funnel is tied to tailnet DNS
  names. If you need `mantis.yourdomain.com` plus browser SSO, Cloudflare
  Tunnel + Access is still the cleaner fit.
- **Apple Wallet callbacks live under `/api/wallet/*`.** They stay public in
  split mode because installed passes need to call back without being on your
  tailnet.
- **The dev inbox is intentionally unsafe for production.** It is an
  unauthenticated capture buffer. Keep `ENABLE_DEV_INBOX=0` unless you are
  actively testing.

## Uninstalling cleanly

Simple mode:

```bash
docker compose --profile tailscale down -v
```

Split mode:

```bash
docker compose --profile tailscale-split down -v
```

The ephemeral nodes disappear from **Machines** shortly after shutdown. Revoke
the auth key in **Settings → Keys** if you do not plan to reuse it.
