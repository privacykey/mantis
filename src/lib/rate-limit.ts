/**
 * Fixed-window rate limiting. Two backends:
 *  - rateLimit(): in-memory, per-process. Multi-instance deployments
 *    under-limit and serverless cold starts reset state. DoS speed-bump only.
 *  - consumeRateLimit(): Postgres-backed, shared across instances — use this
 *    where the cap must hold cluster-wide (e.g. auth brute-force).
 */

import { sql } from "drizzle-orm";
import { db } from "@/db/client";
import { log } from "@/lib/log";

type Bucket = { count: number; resetAt: number };

const PRUNE_AT = 5_000;
const buckets = new Map<string, Bucket>();

export type RateLimitResult = {
  ok: boolean;
  remaining: number;
  resetAt: number;
};

export function rateLimit(
  key: string,
  opts: { limit: number; windowMs: number },
): RateLimitResult {
  const now = Date.now();
  const existing = buckets.get(key);

  if (!existing || existing.resetAt <= now) {
    const fresh: Bucket = { count: 1, resetAt: now + opts.windowMs };
    buckets.set(key, fresh);
    pruneIfNeeded(now);
    return { ok: true, remaining: opts.limit - 1, resetAt: fresh.resetAt };
  }

  if (existing.count >= opts.limit) {
    return { ok: false, remaining: 0, resetAt: existing.resetAt };
  }

  existing.count += 1;
  return {
    ok: true,
    remaining: opts.limit - existing.count,
    resetAt: existing.resetAt,
  };
}

function pruneIfNeeded(now: number): void {
  if (buckets.size < PRUNE_AT) return;
  for (const [k, b] of buckets) {
    if (b.resetAt <= now) buckets.delete(k);
  }
}

export function rateLimitHeaders(r: RateLimitResult): Record<string, string> {
  return {
    "X-RateLimit-Remaining": String(Math.max(0, r.remaining)),
    "X-RateLimit-Reset": String(Math.ceil(r.resetAt / 1000)),
    ...(r.ok ? {} : { "Retry-After": String(Math.max(1, Math.ceil((r.resetAt - Date.now()) / 1000))) }),
  };
}

/**
 * Postgres-backed fixed-window limiter. Window state lives in one row per key,
 * so the cap holds across all instances/invocations — the gap rateLimit()
 * above can't close. One atomic UPSERT per call (the ON CONFLICT row lock
 * serializes concurrent increments).
 *
 * Fails OPEN: a DB error allows the request and logs. The limiter is a
 * brute-force speed-bump, not an authz boundary, so availability wins over
 * strict enforcement when the DB is unreachable.
 */
export async function consumeRateLimit(
  key: string,
  opts: { limit: number; windowMs: number },
): Promise<RateLimitResult> {
  const fallback = (): RateLimitResult => ({
    ok: true,
    remaining: opts.limit - 1,
    resetAt: Date.now() + opts.windowMs,
  });
  try {
    const expired = sql`rate_limits.window_start <= now() - (${opts.windowMs}::bigint * interval '1 millisecond')`;
    const res = await db.execute<{ count: number; window_start: Date }>(sql`
      INSERT INTO rate_limits (key, window_start, count)
      VALUES (${key}, now(), 1)
      ON CONFLICT (key) DO UPDATE SET
        count = CASE WHEN ${expired} THEN 1 ELSE rate_limits.count + 1 END,
        window_start = CASE WHEN ${expired} THEN now() ELSE rate_limits.window_start END
      RETURNING count, window_start
    `);
    const row = res[0];
    if (!row) return fallback();
    const count = Number(row.count);
    const resetAt = new Date(row.window_start).getTime() + opts.windowMs;
    return {
      ok: count <= opts.limit,
      remaining: Math.max(0, opts.limit - count),
      resetAt,
    };
  } catch (err) {
    log.warn({ err, key }, "rate limiter DB error — failing open");
    return fallback();
  }
}
