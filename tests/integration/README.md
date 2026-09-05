# Integration tests (full-stack, real Postgres)

These tests import the real Next.js **route handlers** / server libraries and run
them against a **real Postgres** — no `@/db` mock. They cover the SQL predicates,
authorization boundaries, and security-fix regressions that the mock-only unit
suite (`vitest.config.ts`, `tests/*.test.ts`) cannot reach.

## Running

```bash
# One-shot: starts an ephemeral Postgres in Docker, migrates, runs, tears down.
pnpm test:integration:db

# Or against a DB you manage yourself (must be migrated):
DATABASE_URL=postgres://mantis:mantis@localhost:5433/mantis_test pnpm test:integration
```

In CI the `test` job's Postgres service container is reused — `pnpm run
test:integration` runs right after the unit suite.

## How it works

- `global-setup.ts` applies the Drizzle migrations once (idempotent).
- `_harness.ts` truncates every touched table **after each test**, and provides
  `seedApiKey` / `seedCanaryKey` / `buildJsonRequest` / `ctxParams` / `waitFor`.
- Handlers are invoked directly with a hand-built `NextRequest` (Tier 1) — no
  `next start` needed. Files run one at a time (`fileParallelism: false`) so they
  don't race on the shared DB.
- `@/lib/log` is mocked per file to avoid the pino-pretty worker; `next/headers`
  (cookies/headers) and `after()` are mocked only where a handler needs them
  outside a request scope.

## Coverage (P0 — done)

| Test | Guards |
| --- | --- |
| `key-isolation` | Cross-tenant IDOR across `/api/keys` (404, not 403/200) |
| `api-key-auth` | Bearer auth: revocation, `lastUsedAt`, no hash leak, 60/min→429 |
| `login-lockout` | Login-flood never locks out a valid credential (a3d143c2) |
| `trigger-suppression` | Lifecycle silence + flood-of-A-can't-blind-B (ef4ca329) |
| `wallet-registration-cap` | Per-key device cap, no leak, refresh path (5573c92c) |
| `inbox-auth` | Dev-inbox read/clear require auth; 404 when flag off (4846c552) |
| `session-lifecycle` | Mint→resolve→revoke; cookie stored as SHA-256 only |
| `secret-at-rest` | Webhook secret sealed (`encv1:`), revealed only on create (2170e3a3) |

## Coverage (P1 — done)

| Test | Guards |
| --- | --- |
| `outbound-ssrf` | safePostJson refuses private/metadata/redirect via the real undici dispatcher; no body oracle (5044e457) |
| `webhook-hmac` | Outbound webhook carries a valid `X-Mantis-Signature` over `${ts}.${body}` |
| `notify-escaping` | Attacker UA/host-context escaped in Slack/Discord/Teams payloads (418d59c7) |
| `notify-retry` | Retry backoff → permanent fail at max_attempts, status-line-only error, `SKIP LOCKED` exactly-once |
| `serving-safety` | `/c` redirect scheme re-check + HTML sandbox CSP; poisoned `javascript:` row → silent GIF |
| `doc-generation` | Hostile memo → escaped OOXML (no XML-illegal control chars) + ICS/VCF lone-CR normalized (d69aad96) |
| `api-key-mgmt` | Admin-only mint/revoke, owner-scoped list, 403-vs-404 hygiene, idempotent revoke |
| `prelaunch-audit` | 2026-09-05 audit guards: global-destination targets redacted for non-admins, foreign `external_id` claims → 409, `/api/audit?actor=` validated, API-key minting admin-only, limiter on session-or-key bearer failures |

Outbound tests use a real loopback HTTP sink (`_sink.ts`) with `ALLOW_PRIVATE_WEBHOOKS=1`;
the SSRF-block cases leave it off. The marquee security guards were mutation-checked
(reverting the fix in source makes the test fail).

## Coverage (P2 — done)

| Test | Guards |
| --- | --- |
| `monitor-status` | Monitor latch: ok → tripped (503) → reset → ok; off/disabled/unknown → 404 not_monitored |
| `cron-drain` | `/api/cron/notifications` fail-closed when `CRON_SECRET` unset, timing-safe bearer, per-IP 429, drains pending |
| `retention-sweep` | Aged-only deletion per category, always-on rate_limits purge, audit purge via GUC, append-only DELETE refused |
| `key-migration` | A v1 (SHA-256) key authenticates and its stored hash is upgraded to v2 (HMAC) on first use |

## Tier-2 (e2e against the production server) — done

The two cases handler imports can't reach live in `tests/tier2/` with their own
config (`vitest.tier2.config.ts`) and runner:

```bash
# One-shot: docker PG → migrate → next build → standalone server → suite.
pnpm test:tier2
```

The runner (`scripts/test-tier2.sh`) serves the real production entrypoint
(`node .next/standalone/server.js`, same as `docker/Dockerfile`) and the tests
drive it over raw HTTP (`node:http`, because fetch forbids the Host header):

| Test | Guards |
| --- | --- |
| `host-split` | The proxy gate is APPLIED by the runtime matcher: dashboard pages/API 404 (empty, `no-store`) on the public-only host but reach handlers on the dashboard host; `/c` still serves; unknown Host fails closed |
| `session-cookie-secure` | The wire-level `Set-Cookie` on a real (no-JS server-action) login: `Secure` present iff `X-Forwarded-Proto: https` / `Forwarded: proto=https`, absent on plain HTTP; `HttpOnly`, `SameSite=Lax`, `Path=/` |

In CI the tier-2 step runs in the `test` job after the integration suite,
reusing its Postgres service (`MANTIS_TIER2_USE_EXISTING_DB=1`). Both processes
(server + vitest) must share `DATABASE_URL` and `MANTIS_API_KEY_PEPPER`; the
script exports matching values to each.
