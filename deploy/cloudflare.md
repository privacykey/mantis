# Deploying mantis with Cloudflare Tunnel (+ Access)

This sets up mantis to run in Docker on your own hardware and exposes it on the public internet at `mantis.<your-domain>` via **Cloudflare Tunnel**. Optionally, you can put parts of mantis behind **Cloudflare Access** for SSO (Google/GitHub/email-OTP/etc.).

When this is the right choice:
- You already own a domain that's on Cloudflare DNS (or are willing to move one).
- You want a `mantis.<your-domain>` URL rather than `*.ts.net`.
- You like the idea of SSO-gating the dashboard for free (up to 50 users).
- You're OK with all mantis traffic flowing through Cloudflare's edge.

## Prerequisites

- Docker + Docker Compose.
- A domain you own. Any registrar.
- Cloudflare account, free tier. Two things must be in place:
  1. The domain's **nameservers must point at Cloudflare**. Add the domain in the main Cloudflare dashboard → it gives you two NS values → change them at your registrar → wait for propagation (5 min to a few hours).
  2. A **Cloudflare Zero Trust team** must be created (free, 50 seats). See Step 1 below.

## Step 1 — Create a Zero Trust team

Cloudflare Zero Trust is a separate dashboard at `https://one.dash.cloudflare.com` (different URL from the main CF dashboard).

1. Go to [one.dash.cloudflare.com](https://one.dash.cloudflare.com). First visit prompts for **team name** — becomes `<team>.cloudflareaccess.com`. Pick whatever.
2. Choose the **Free** plan (50 seats).
3. (Skip for now) Identity providers. We'll come back to this only if you decide to enable Access in Step 7.

## Step 2 — Create the tunnel

1. **Networks → Tunnels → Create a tunnel**.
2. **Connector type**: `Cloudflared`.
3. Name: `mantis` → Save.
4. The next screen shows install commands for various OSes. **Ignore them** — we run cloudflared inside Docker via our compose file. What you need is the **key** (long JWT) shown under "Install and run a connector". Copy it.
5. Click **Next**.
6. **Public Hostnames** tab → Add a public hostname:
   - **Subdomain**: `mantis` (or your preference)
   - **Domain**: select your zone
   - **Path**: leave blank (matches everything)
   - **Type**: `HTTP`
   - **URL**: `mantis:3000`  ← this is the Docker service name; cloudflared resolves it via the compose network
   - **Additional application settings → HTTP Settings → HTTP Host Header**: `mantis.<your-domain>` (helps with cookie domain matching for the dashboard)
7. **Save** → Cloudflare auto-creates the DNS record. No manual DNS needed.

## Step 3 — Configure and start

```bash
cd mantis
cp .env.example .env
# Edit .env:
#   CLOUDFLARE_TUNNEL_TOKEN=eyJh...
#   PUBLIC_BASE_URL=https://mantis.<your-domain>

docker compose --profile cloudflared up -d
```

## Step 4 — Verify

```bash
docker compose logs cloudflared | grep "Registered tunnel"
# Should see 4 lines, one per Cloudflare edge connection
```

```bash
curl -i https://mantis.<your-domain>/status/nonexistent
# 404 not_monitored JSON from mantis = working
```

Browser: open `https://mantis.<your-domain>` → mantis `/login`.

## Step 5 — Add public edge limits

Before sharing trigger URLs broadly, add Cloudflare rules for the public Mantis
surfaces:

- block oversized `/c/*`, `/status/*`, and `/api/wallet/*` URLs
- rate-limit `/c/*` and `/status/*` by client IP
- keep `/inbox*` and `/api/inbox` blocked unless this is a deliberate dev box

Use the exact expressions and suggested thresholds in
[`deploy/edge-limits.md`](./edge-limits.md#cloudflare-tunnel-or-cloudflare-in-front-of-any-host).

## Step 6 — Bootstrap an API key

```bash
docker compose logs mantis | grep -A1 "bootstrap API key"
```

Paste into the dashboard login.

---

## Step 7 (optional) — Cloudflare Access

**This is the part where you need to make a decision.** Before adding Access, decide what paths to gate. There are three reasonable levels:

| Level | Paths gated by CF Access | CLI works? | Webhook delivery to mantis? | Dashboard auth |
|---|---|---|---|---|
| **No Access** | nothing | Yes | Yes | API key only |
| **Dashboard-only** | `/`, `/keys/*`, `/login*`, `/logout*` | Yes | Yes | CF SSO + API key |
| **Full (recommended)** | above + management API routes (`/api/keys*`, `/api/api-keys*`, `/api/cron*`, optionally `/api/health`) | **Yes** via `mantis cloudflare login` or `set-service-auth` | Yes (webhooks hit `/c/*`, `/status/*`, wallet callbacks, and optional dev inbox routes which stay open) | CF SSO + API key |

> The CLI now supports auth-passthrough for Cloudflare Access. The auth flow happens entirely on your machine: the CLI gets a short-lived JWT from `cloudflared` (via SSO) **or** sends a Service Auth header pair — and forwards it on every management API call. Mantis itself doesn't validate Cloudflare JWTs; it just receives requests that have already passed CF's gate, then validates the API key as usual. The server stays unaware of Cloudflare.

### Recommended setup: full gating with CLI passthrough

The CLI handles Cloudflare auth client-side. Server is none the wiser. Two flavors, pick one:

#### Option 1 — SSO (real user identity, recommended for personal use)

Requires the `cloudflared` binary on every machine where you run the CLI.

```bash
# 1. Install cloudflared once:
#    https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/
brew install cloudflared    # macOS

# 2. Authenticate (opens browser to your Cloudflare Access SSO):
mantis cloudflare login --app=https://mantis.your-domain.com

# 3. Verify:
mantis cloudflare status
#   mode:        sso
#   app URL:     https://mantis.your-domain.com
#   cloudflared: installed
#   key:       cached + valid

# 4. Use normally — CLI auto-injects the Cloudflare JWT on every /api/* call:
mantis list
mantis hits <id>
```

Re-run `mantis cloudflare login` whenever the JWT expires (Cloudflare default: 24h).

#### Option 2 — Service Auth (headless / CI use, pre-shared key)

For machines where opening a browser isn't an option (servers, CI runners, etc.):

```bash
# 1. In Cloudflare Zero Trust → Access → Service Auth → Create Service Key
#    Name it "mantis cli". Copy the Client-ID (ends in .access) and Client-Secret.
# 2. Edit the Mantis Access application: add a Service Auth policy that allows
#    this service key (Access app → Edit → Policies → Add → "Service Auth").
# 3. Configure the CLI:
mantis cloudflare set-service-auth \
  --client-id  <id>.access \
  --client-secret <secret>

# 4. Verify + use:
mantis cloudflare status
mantis list
```

The CLI sends `CF-Access-Client-Id` and `CF-Access-Client-Secret` headers on every `/api/*` request. Cloudflare Access validates them at the edge and passes through.

#### Cloudflare app configuration (either option)

1. **Settings → Authentication → Login methods**. Add at least one (email OTP is simplest; SSO providers for teams).
2. **Access → Applications → Add an application** → Self-hosted.
3. **Configuration:**
   - **Application name**: "Mantis"
   - **Session duration**: 24h
   - **Application Domain**: `mantis.<your-domain>`
4. **Paths**: gate dashboard and management API routes:
   - `/`
   - `/login*`
   - `/logout*`
   - `/keys*`
   - `/api/keys*`
   - `/api/api-keys*`
   - `/api/cron*`
5. **Identity providers** (for Option 1 / browser SSO): tick the methods you configured.
6. **Policies** → add as needed:
   - **Operator** — Allow, Selector: Emails matching your address (for SSO / browser login).
   - **Mantis CLI** — Service Auth, Selector: your service key (only if using Option 2).
7. **Save**.

What stays public (don't gate these):
- `/c/*` — mantis triggers. **Must** be public; this is the whole point.
- `/status/*` — Uptime Kuma monitor URLs. **Must** be public so Uptime Kuma can poll.
- `/api/wallet/*` — Apple Wallet callbacks. Required only if you enable `.pkpass` support.
- `/api/health` — optional public health check. Gate it unless an external public monitor needs it.
- `/inbox*` and `/api/inbox` — dev webhook inbox. Disable for production with `ENABLE_DEV_INBOX=0` if you don't need it.

### After Access is on

**Dashboard (browser):**
1. Visit `https://mantis.<your-domain>/keys` → Cloudflare redirects to `<team>.cloudflareaccess.com` → email-OTP / SSO login.
2. After auth, redirects back to mantis.
3. Mantis shows `/login` (paste API key).
4. After paste, dashboard appears.

Effectively two-factor (CF SSO + mantis API key). If the double login bothers you, lobby for the "mint mantis session from CF JWT" feature — it would replace step 3.

**CLI:**
- With SSO mode: the CLI calls `cloudflared access token --app=…` for each request, getting a cached short-lived JWT. Transparent after the initial `mantis cloudflare login`.
- With Service Auth: the CLI sends the stored Client-ID/Secret headers. No browser interaction ever.
- All credential state lives on your machine. The mantis server never sees Cloudflare config and doesn't need to verify anything Cloudflare-related — Access has already validated the request before mantis ever sees it.

---

## Gotchas

- **Cloudflare terminates TLS.** All mantis traffic — including potentially sensitive hit metadata — passes through Cloudflare's edge in plaintext. If your mantis catches genuinely confidential content (email contents, document bodies), CF logs see it. Privacy tradeoff worth knowing.
- **Free Access seats: 50.** Plenty for personal / small team. Past that, paid plan.
- **Origin protection.** Cloudflare recommends locking your origin to only accept traffic from CF IPs. Mantis already binds to `127.0.0.1` (only reachable inside the Docker network, where cloudflared also lives), so this is taken care of without extra config.
- **Cloudflare Access cookie + Set-Cookie domain.** If you see the dashboard login cookie not sticking, check the HTTP Host Header setting from Step 2.6 — it should be `mantis.<your-domain>`, not `localhost:3000`.

## Uninstalling cleanly

```bash
docker compose --profile cloudflared down
```

- In Cloudflare Zero Trust: **Networks → Tunnels → mantis → Delete**. Also removes the DNS record.
- **Access → Applications → Mantis dashboard → Delete** if you set that up.
- The DNS record auto-cleans on tunnel deletion (Cloudflare-managed).
