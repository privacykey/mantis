import { describe, expect, it, vi, beforeEach } from "vitest";

// runRetentionSweep issues one db.execute per active category plus an
// always-on rate_limits cleanup; mock the client so we can assert which
// statements run without a live Postgres.
const executeMock = vi.hoisted(() => vi.fn());
const transactionMock = vi.hoisted(() => vi.fn());
vi.mock("@/db/client", () => ({
  db: { execute: executeMock, transaction: transactionMock },
}));
// Avoid spinning up the real pino-pretty transport (worker thread).
vi.mock("@/lib/log", () => ({
  log: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { runRetentionSweep } from "@/lib/retention";

const RETENTION_VARS = [
  "MANTIS_HIT_RETENTION_DAYS",
  "MANTIS_NOTIFICATION_RETENTION_DAYS",
  "MANTIS_AUDIT_RETENTION_DAYS",
  "MANTIS_SESSION_RETENTION_DAYS",
];

describe("runRetentionSweep — rate_limits cleanup", () => {
  beforeEach(() => {
    executeMock.mockReset();
    transactionMock.mockReset();
    for (const v of RETENTION_VARS) delete process.env[v];
  });

  it("always sweeps rate_limits even when no retention env vars are set", async () => {
    executeMock.mockResolvedValue([{ count: "3" }]);

    const res = await runRetentionSweep();

    // Only the unconditional rate_limits cleanup runs; the env-gated
    // categories stay off.
    expect(executeMock).toHaveBeenCalledTimes(1);
    expect(res.rateLimitsDeleted).toBe(3);
    expect(res.hitsDeleted).toBe(0);
    expect(res.notificationsDeleted).toBe(0);
    expect(res.auditEventsDeleted).toBe(0);
    expect(res.sessionsDeleted).toBe(0);
  });

  it("reports zero when no rows are expired", async () => {
    executeMock.mockResolvedValue([{ count: "0" }]);

    const res = await runRetentionSweep();

    expect(res.rateLimitsDeleted).toBe(0);
  });

  it("targets the rate_limits table by window_start age", async () => {
    executeMock.mockResolvedValue([{ count: "1" }]);

    await runRetentionSweep();

    const arg = executeMock.mock.calls[0]?.[0];
    const rendered = JSON.stringify(arg?.queryChunks ?? arg);
    expect(rendered).toContain("rate_limits");
    expect(rendered).toContain("window_start");
  });
});

// The cron endpoint calls this on every authorised request (typically once a
// minute); it must sweep about hourly, not every call. The first db.execute is
// the slot claim (consumeRateLimit's UPSERT), the next is the sweep itself.
describe("runRetentionSweepIfDue — hourly throttle for cron mode", () => {
  beforeEach(() => {
    executeMock.mockReset();
    transactionMock.mockReset();
    for (const v of RETENTION_VARS) delete process.env[v];
    vi.resetModules();
  });

  const slot = (count: number, windowStart = new Date()) => [
    { count, window_start: windowStart },
  ];

  it("sweeps when it wins the slot, then stays idle without touching the DB", async () => {
    const { runRetentionSweepIfDue } = await import("@/lib/retention");
    executeMock
      .mockResolvedValueOnce(slot(1)) // slot claimed
      .mockResolvedValueOnce([{ count: "2" }]); // rate_limits purge

    const first = await runRetentionSweepIfDue();
    expect(first?.rateLimitsDeleted).toBe(2);
    expect(executeMock).toHaveBeenCalledTimes(2);
    const claim = JSON.stringify(
      executeMock.mock.calls[0]?.[0]?.queryChunks ?? executeMock.mock.calls[0]?.[0],
    );
    expect(claim).toContain("retention-sweep");

    // Per-minute cron calls for the rest of the hour: no slot query, no sweep.
    expect(await runRetentionSweepIfDue()).toBeNull();
    expect(await runRetentionSweepIfDue()).toBeNull();
    expect(executeMock).toHaveBeenCalledTimes(2);
  });

  it("does not sweep when another instance already holds this hour's slot", async () => {
    const { runRetentionSweepIfDue } = await import("@/lib/retention");
    // count 2 ⇒ someone else claimed the window 20 minutes ago.
    executeMock.mockResolvedValueOnce(slot(2, new Date(Date.now() - 20 * 60_000)));

    expect(await runRetentionSweepIfDue()).toBeNull();
    expect(executeMock).toHaveBeenCalledTimes(1); // the claim attempt only

    // …and it does not ask again until that slot has run out.
    expect(await runRetentionSweepIfDue()).toBeNull();
    expect(executeMock).toHaveBeenCalledTimes(1);
  });

  it("asks again once the slot it lost has expired", async () => {
    vi.useFakeTimers();
    try {
      const { runRetentionSweepIfDue } = await import("@/lib/retention");
      executeMock.mockResolvedValueOnce(slot(2, new Date(Date.now() - 20 * 60_000)));
      expect(await runRetentionSweepIfDue()).toBeNull();

      vi.setSystemTime(Date.now() + 41 * 60_000);
      executeMock
        .mockResolvedValueOnce(slot(1))
        .mockResolvedValueOnce([{ count: "0" }]);
      expect(await runRetentionSweepIfDue()).not.toBeNull();
      expect(executeMock).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });
});
