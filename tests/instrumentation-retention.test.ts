import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Boot-time signal for "retention configured but nothing will run it": with
// the in-process notify worker off (Vercel, RUN_NOTIFY_WORKER=0) the hourly
// sweep only runs from /api/cron/notifications. The operator must be told,
// instead of the MANTIS_*_RETENTION_DAYS windows being silently inert.

const mocks = vi.hoisted(() => ({
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  startNotifyWorker: vi.fn(),
}));
vi.mock("@/lib/log", () => ({
  log: { warn: mocks.warn, info: mocks.info, error: mocks.error, debug: vi.fn() },
}));
vi.mock("@/db/bootstrap", () => ({ bootstrapIfEmpty: async () => {} }));
vi.mock("@/lib/notify", () => ({ startNotifyWorker: mocks.startNotifyWorker }));

import { register } from "@/instrumentation";

const warnings = () => mocks.warn.mock.calls.map((c) => String(c[0]));
const disabledWorkerWarning = () =>
  warnings().find((m) => m.includes("notify worker is disabled"));

beforeEach(() => {
  mocks.warn.mockReset();
  mocks.startNotifyWorker.mockReset();
  vi.stubEnv("NEXT_RUNTIME", "nodejs");
  for (const name of [
    "AUTO_MIGRATE",
    "ENABLE_DEV_INBOX",
    "VERCEL",
    "RUN_NOTIFY_WORKER",
    "CRON_SECRET",
    "MANTIS_HIT_RETENTION_DAYS",
    "MANTIS_NOTIFICATION_RETENTION_DAYS",
    "MANTIS_AUDIT_RETENTION_DAYS",
    "MANTIS_SESSION_RETENTION_DAYS",
  ]) {
    vi.stubEnv(name, "");
  }
});
afterEach(() => vi.unstubAllEnvs());

describe("register() — retention with the notify worker disabled", () => {
  it.each([
    "MANTIS_HIT_RETENTION_DAYS",
    "MANTIS_NOTIFICATION_RETENTION_DAYS",
    "MANTIS_AUDIT_RETENTION_DAYS",
    "MANTIS_SESSION_RETENTION_DAYS",
  ])("warns when %s is set and RUN_NOTIFY_WORKER=0", async (name) => {
    vi.stubEnv("RUN_NOTIFY_WORKER", "0");
    vi.stubEnv(name, "30");

    await register();

    expect(mocks.startNotifyWorker).not.toHaveBeenCalled();
    const message = disabledWorkerWarning();
    expect(message).toBeDefined();
    expect(message).toContain("/api/cron/notifications");
    // No CRON_SECRET ⇒ the endpoint refuses every call; say that too.
    expect(message).toContain("CRON_SECRET is not set");
  });

  it("warns on Vercel, where the worker is off by default", async () => {
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("MANTIS_HIT_RETENTION_DAYS", "90");
    vi.stubEnv("CRON_SECRET", "configured");

    await register();

    const message = disabledWorkerWarning();
    expect(message).toBeDefined();
    expect(message).not.toContain("CRON_SECRET is not set");
  });

  it("stays quiet when no retention window is configured", async () => {
    vi.stubEnv("RUN_NOTIFY_WORKER", "0");
    await register();
    expect(disabledWorkerWarning()).toBeUndefined();
  });

  it("stays quiet when the worker runs (it carries the sweep itself)", async () => {
    vi.stubEnv("MANTIS_HIT_RETENTION_DAYS", "90");
    await register();
    expect(mocks.startNotifyWorker).toHaveBeenCalledTimes(1);
    expect(disabledWorkerWarning()).toBeUndefined();
  });
});
