# Railway deploy

Railway runs the mantis as a long-running container with their Postgres add-on. No template button (yet) — manual setup takes ~3 minutes.

## Steps

1. Fork this repo (so Railway can hook into your GitHub).
2. Go to [railway.app/new](https://railway.app/new) → **Deploy from GitHub repo** → pick the fork.
3. Railway auto-detects the Next.js app and starts a build. **Cancel the first build** — we need to add Postgres and env vars first.
4. In the project, click **+ New** → **Database** → **Add PostgreSQL**. Railway provisions it and exposes `DATABASE_URL` as a service variable.
5. On the mantis service, **Variables** → add:
   - `DATABASE_URL` → use the **Reference** syntax to link to the Postgres service: `${{ Postgres.DATABASE_URL }}`
   - `PUBLIC_BASE_URL` → leave blank for now; you'll fill it in after step 7
   - `AUTO_MIGRATE` → `1`
   - `BOOTSTRAP_API_KEY` → generate one with `node -e "console.log('mantis_live_' + require('crypto').randomBytes(24).toString('base64url'))"` and save it locally — you'll need it to log into the dashboard
   - (Optional) `SMTP_URL`, `SMTP_FROM` for email notifications
6. On the mantis service, **Settings** → **Networking** → **Generate Domain**. Railway gives you a `<name>.up.railway.app` URL.
7. Set `PUBLIC_BASE_URL` to that URL (e.g., `https://mantis.up.railway.app`) and redeploy.
8. Before broad public use, decide whether to keep the Railway domain directly
   exposed or put a Cloudflare-proxied custom domain in front for WAF/rate
   limiting. See [public edge limits](./edge-limits.md#railway).
9. Visit `https://<your-domain>/login`, paste the `BOOTSTRAP_API_KEY` you generated. Done.

## Public edge limits

Railway's edge currently enforces useful platform limits, including a 32 KB
combined request-header limit and network-level DDoS mitigation, but Railway
does not provide an application-layer WAF. For public Mantis trigger URLs, the
recommended production posture is:

1. Add a custom domain to the Mantis Railway service.
2. Put that hostname behind Cloudflare's orange-cloud proxy.
3. Configure the `/c/*`, `/status/*`, and optional `/api/wallet/*` rules in
   [public edge limits](./edge-limits.md#cloudflare-tunnel-or-cloudflare-in-front-of-any-host).
4. Set `TRUST_PROXY_HEADERS=1` only when Cloudflare is the public entry point
   and no direct Railway hostname is advertised.

## Notes

- Railway no longer has a true free tier; expect ~$5/month for the smallest combined plan (mantis service + Postgres).
- The notify worker runs natively (no cron config needed — `instrumentation.ts` auto-detects non-Vercel and starts it).
- Auto-deploys on push to the connected branch.
- To use an external Postgres (Neon, Supabase) instead of Railway Postgres: drop the linked DB and set `DATABASE_URL` to an external connection string.

## Redis/Valkey for rate limiting?

Not by default. A shared Redis/Valkey limiter is useful only if you run multiple
Mantis replicas or need strict shared counters. For a single Railway Mantis
service, start with Cloudflare/proxy limits plus the built-in duplicate
suppression.

Railway Redis is deployed as another service. Using Railway's current resource
pricing, a tiny 256 MB Redis/Valkey service is about $2.50/month in RAM before
CPU and storage; Hobby's $5/month minimum counts toward usage, so it may fit
inside the minimum if the rest of the project is small. It does add another
private-network round trip to each `/c/*` hit and another service to operate.
