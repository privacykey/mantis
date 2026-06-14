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
