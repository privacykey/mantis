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
| `trigger-suppression` | Lifecycle silence + flood-of-A-can't-blind-B (ef4ca329); junk requests from one IP never drop a live key's hit from that IP; `<trigger URL>/<appended path>` fires the key |
| `wallet-registration-cap` | Per-key device cap, no leak, refresh path (5573c92c) |
| `inbox-auth` | Dev-inbox read/clear require auth; 404 when flag off (4846c552); credential headers stored as `[redacted]` |
| `session-lifecycle` | Mint→resolve→revoke; cookie stored as SHA-256 only |
| `secret-at-rest` | Webhook secret sealed (`encv1:`), revealed only on create (2170e3a3) |

## Coverage (P1 — done)

| Test | Guards |
| --- | --- |
| `outbound-ssrf` | safePostJson refuses private/metadata (incl. bracketed IPv6 literals) and its own origin via the real undici dispatcher, with one constant refusal message; redirects refused and reported by origin only; no body oracle (5044e457) |
| `webhook-hmac` | Outbound webhook carries a valid `X-Mantis-Signature` over `${ts}.${body}` |
| `notify-escaping` | Attacker UA/Referer/host-context escaped in Slack/Discord/Teams payloads (418d59c7) |
| `activation-refusal` | Probing private/internal destinations yields one constant activation error (no resolver answer in the response or the stored row); an enrollment key cannot probe at all and never sees error text; a destination pointing back at this instance is refused at creation |
| `enroll-hardening` | An extracted enrollment key mints inert tripwires only (no lifecycle, monitoring, trigger content or unapproved destinations; hourly creation cap); `external_id` claims stay inside the claimer's fleet, dead keys are never handed back, admins adopt explicitly; `?mine=1`; control characters refused in memos and targets |
| `self-origins` | `self_origins` stored in URL.origin form; own-site hits neither anchor the dedupe window nor hide a clone-site hit |
| `dashboard-audit` | Dashboard actions that create keys or change routing/monitoring write the same audit rows as their API siblings |
| `install-webhook-id` | The Home Assistant receiver's webhook id is stable across renders and not derivable from the key id |
| `alert-links` | No human-facing alert or activation message carries the trigger URL; following every URL a person is shown records no hit (control: webhook `key.url` does fire) |
| `notify-redaction` | `last_error` of a global destination is reduced to its status for non-admin owners (no redirect Location, host or recipient); admins and own-destination owners read it in full |
| `destination-removal` | Removing a per-key or global destination aborts its pending / retrying / in-flight deliveries in the same transaction; a claimed worker is fenced |
| `global-destination-admin` | Global webhook signing secret: admin-only audited reveal + rotate that verify real deliveries; replacing the global set writes `global_destinations.replaced` (counts/channels, never targets) |
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
| `monitor-status` | Monitor latch at `/status/<publicId>.<tag>`: ok → tripped (503) → reset → ok; bare id / wrong tag / off / disabled / unknown → the same body-less 404; API reset writes a `monitor.reset` audit row |
| `cron-drain` | `/api/cron/notifications` fail-closed when `CRON_SECRET` unset, timing-safe bearer, per-IP 429, drains pending; runs the retention sweep about hourly |
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
| `host-split` | The proxy gate is APPLIED by the runtime matcher: dashboard pages/API 404 (empty, `no-store`) on the public-only host but reach handlers on the dashboard host; `/c` still serves; unknown Host fails closed; a status URL without its tag is header-identical to a blocked path |
| `trigger-appended-path` | `<trigger URL>/<anything>`, a trailing slash and any method reach the trigger handler under the default and a custom prefix; other trailing-slash paths still 308 |
| `session-cookie-secure` | The wire-level `Set-Cookie` on a real (no-JS server-action) login: `Secure` present iff `X-Forwarded-Proto: https` / `Forwarded: proto=https`, absent on plain HTTP; `HttpOnly`, `SameSite=Lax`, `Path=/` |

In CI the tier-2 step runs in the `test` job after the integration suite,
reusing its Postgres service (`MANTIS_TIER2_USE_EXISTING_DB=1`). Both processes
(server + vitest) must share `DATABASE_URL` and `MANTIS_API_KEY_PEPPER`; the
script exports matching values to each.
