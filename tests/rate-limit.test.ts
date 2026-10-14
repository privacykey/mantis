import { afterEach, describe, expect, it, vi, beforeEach } from "vitest";

// consumeRateLimit issues one db.execute UPSERT; mock the client so we can
// drive the returned count without a live Postgres.
const executeMock = vi.hoisted(() => vi.fn());
vi.mock("@/db/client", () => ({ db: { execute: executeMock } }));
// Avoid spinning up the real pino-pretty transport (worker thread) for the
// fail-open path's log.warn.
vi.mock("@/lib/log", () => ({
  log: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  rateLimit,
  rateLimitBucketCount,
  consumeRateLimit,
  rateLimitHeaders,
} from "@/lib/rate-limit";

describe("rateLimit (in-memory)", () => {
  it("allows up to the limit, then blocks, with correct remaining", () => {
    const key = "inmem-a";
    expect(rateLimit(key, { limit: 2, windowMs: 10_000 })).toMatchObject({
      ok: true,
      remaining: 1,
    });
    expect(rateLimit(key, { limit: 2, windowMs: 10_000 })).toMatchObject({
      ok: true,
      remaining: 0,
    });
    expect(rateLimit(key, { limit: 2, windowMs: 10_000 })).toMatchObject({
      ok: false,
      remaining: 0,
    });
  });

  it("keeps separate windows per key", () => {
    expect(rateLimit("inmem-b", { limit: 1, windowMs: 10_000 }).ok).toBe(true);
    expect(rateLimit("inmem-b", { limit: 1, windowMs: 10_000 }).ok).toBe(false);
    // Different key is unaffected.
    expect(rateLimit("inmem-c", { limit: 1, windowMs: 10_000 }).ok).toBe(true);
  });
});

// A flood of distinct keys (one per client IP) used to make every NEW key pay a
// full scan of the map once it held 5,000 buckets, and the map had no ceiling.
describe("rateLimit (in-memory) — bucket pruning", () => {
  const WINDOW = { limit: 5, windowMs: 60_000 } as const;
  const T0 = 1_800_000_000_000;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });
  afterEach(() => {
    // Leave the shared map empty for the rest of the file: everything inserted
    // here has expired by now, and one insert past the sweep interval drops it.
    vi.setSystemTime(Date.now() + 10 * 60_000);
    rateLimit("prune-reset", { limit: 1, windowMs: 1 });
    vi.useRealTimers();
  });

  it("holds a hard cap on live buckets while nothing has expired", () => {
    // Frozen clock: no bucket ever expires, so only the cap can bound the map.
    for (let i = 0; i < 60_000; i++) rateLimit(`flood:${i}`, WINDOW);
    expect(rateLimitBucketCount()).toBeLessThanOrEqual(50_000);

    // The newest keys are the ones kept (eviction takes the oldest windows)…
    expect(rateLimit("flood:59999", WINDOW).remaining).toBe(WINDOW.limit - 2);
    // …and an evicted key just starts a fresh window, it is never blocked.
    expect(rateLimit("flood:0", WINDOW)).toMatchObject({
      ok: true,
      remaining: WINDOW.limit - 1,
    });
  });

  it("does not rescan the map for every new key above the prune threshold", () => {
    for (let i = 0; i < 6_000; i++) rateLimit(`scan:${i}`, WINDOW);

    // Count full-map iterations triggered by the next 2,000 new keys, all
    // arriving within the same second.
    const iterate = vi.spyOn(Map.prototype, Symbol.iterator);
    try {
      for (let i = 6_000; i < 8_000; i++) rateLimit(`scan:${i}`, WINDOW);
      expect(iterate.mock.calls.length).toBeLessThanOrEqual(1);
    } finally {
      iterate.mockRestore();
    }
  });

  it("still sweeps expired buckets once their window has passed", () => {
    for (let i = 0; i < 6_000; i++) rateLimit(`sweep:${i}`, WINDOW);
    expect(rateLimitBucketCount()).toBeGreaterThanOrEqual(6_000);

    vi.setSystemTime(Date.now() + WINDOW.windowMs + 1);
    rateLimit("sweep:after", WINDOW);
    // Everything from the first window is gone; only live buckets remain.
    expect(rateLimitBucketCount()).toBeLessThan(5_000);
  });

  it("keeps enforcing the limit for a key that stays in the map", () => {
    for (let i = 0; i < 6_000; i++) rateLimit(`noise:${i}`, WINDOW);
    for (let i = 0; i < WINDOW.limit; i++) {
      expect(rateLimit("victim", WINDOW).ok).toBe(true);
    }
    for (let i = 6_000; i < 7_000; i++) rateLimit(`noise:${i}`, WINDOW);
    expect(rateLimit("victim", WINDOW).ok).toBe(false);
  });
});

describe("consumeRateLimit (Postgres-backed)", () => {
  beforeEach(() => executeMock.mockReset());

  it("allows while the count is within the limit", async () => {
    executeMock.mockResolvedValue([{ count: 1, window_start: new Date() }]);
    const r = await consumeRateLimit("auth-fail:1.2.3.4", {
      limit: 5,
      windowMs: 60_000,
    });
    expect(r.ok).toBe(true);
    expect(r.remaining).toBe(4);
  });

  it("allows exactly at the limit and blocks past it", async () => {
    executeMock.mockResolvedValue([{ count: 5, window_start: new Date() }]);
    expect((await consumeRateLimit("k", { limit: 5, windowMs: 60_000 })).ok).toBe(true);

    executeMock.mockResolvedValue([{ count: 6, window_start: new Date() }]);
    const blocked = await consumeRateLimit("k", { limit: 5, windowMs: 60_000 });
    expect(blocked.ok).toBe(false);
    expect(blocked.remaining).toBe(0);
  });

  it("fails OPEN (allows, full window) on the fallback path", async () => {
    // An empty result hits `return fallback()` — the exact value the catch
    // also returns when the DB is unreachable, so this covers fail-open.
    // (A mock that throws/rejects directly is surfaced by vitest as an
    // uncaught error even though consumeRateLimit handles it, so we drive the
    // shared fallback via an empty row set instead.)
    executeMock.mockResolvedValue([]);
    const r = await consumeRateLimit("k", { limit: 5, windowMs: 60_000 });
    expect(r.ok).toBe(true);
    expect(r.remaining).toBe(4);
  });
});

describe("rateLimitHeaders", () => {
  it("adds Retry-After only when blocked", () => {
    const blocked = rateLimitHeaders({ ok: false, remaining: 0, resetAt: Date.now() + 5000 });
    expect(blocked["Retry-After"]).toBeDefined();
    const ok = rateLimitHeaders({ ok: true, remaining: 3, resetAt: Date.now() + 5000 });
    expect(ok["Retry-After"]).toBeUndefined();
  });
});
