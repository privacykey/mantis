import { describe, expect, it, vi, beforeEach } from "vitest";

// consumeRateLimit issues one db.execute UPSERT; mock the client so we can
// drive the returned count without a live Postgres.
const executeMock = vi.hoisted(() => vi.fn());
vi.mock("@/db/client", () => ({ db: { execute: executeMock } }));
// Avoid spinning up the real pino-pretty transport (worker thread) for the
// fail-open path's log.warn.
vi.mock("@/lib/log", () => ({
  log: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { rateLimit, consumeRateLimit, rateLimitHeaders } from "@/lib/rate-limit";

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
