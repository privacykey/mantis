import { describe, it, expect, vi, afterEach } from "vitest";

// E2E-21 — runRetentionSweep against real Postgres: each env-gated category
// deletes only aged/eligible rows (fresh ones stay), spent rate_limits are
// always purged regardless of env, the audit purge succeeds via the
// transaction-local GUC, and a bare DELETE on audit_events is refused by the
// append-only trigger.

vi.mock("@/lib/log", () => ({
  log: { info() {}, warn() {}, error() {}, debug() {}, fatal() {}, trace() {} },
}));

import { runRetentionSweep } from "@/lib/retention";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { hits, notifications, auditEvents, sessions, rateLimits } from "@/db/schema";
import { seedApiKey, seedCanaryKey } from "./_harness";

const DAY = 86_400_000;
const aged = () => new Date(Date.now() - 10 * DAY);

const RETENTION_VARS = [
  "MANTIS_HIT_RETENTION_DAYS",
  "MANTIS_NOTIFICATION_RETENTION_DAYS",
  "MANTIS_AUDIT_RETENTION_DAYS",
  "MANTIS_SESSION_RETENTION_DAYS",
];
afterEach(() => {
  for (const v of RETENTION_VARS) delete process.env[v];
});

async function exists(query: Promise<{ length: number }>): Promise<boolean> {
  return (await query).length === 1;
}

describe("E2E-21 retention sweep + audit trigger", () => {
  it("deletes aged/eligible rows, keeps fresh, always purges spent rate_limits", async () => {
    const owner = await seedApiKey();
    const key = await seedCanaryKey(owner.row.id);

    const [agedHit] = await db.insert(hits).values({ keyId: key.id, occurredAt: aged() }).returning();
    const [freshHit] = await db.insert(hits).values({ keyId: key.id }).returning();

    // Attached to freshHit so hit-retention's cascade doesn't remove them.
    const [agedNotif] = await db
      .insert(notifications)
      .values({ hitId: freshHit!.id, keyId: key.id, channel: "webhook", target: "https://x.example/h", status: "succeeded", updatedAt: aged() })
      .returning();
    const [freshNotif] = await db
      .insert(notifications)
      .values({ hitId: freshHit!.id, keyId: key.id, channel: "webhook", target: "https://x.example/h", status: "pending" })
      .returning();

    const [agedAudit] = await db.insert(auditEvents).values({ eventType: "key.created", occurredAt: aged() }).returning();
    const [freshAudit] = await db.insert(auditEvents).values({ eventType: "key.created" }).returning();

    const [agedSession] = await db
      .insert(sessions)
      .values({ tokenHash: `aged-${key.id}`, tokenPrefix: "ses", apiKeyId: owner.row.id, expiresAt: aged(), revokedAt: aged() })
      .returning();
    const [activeSession] = await db
      .insert(sessions)
      .values({ tokenHash: `active-${key.id}`, tokenPrefix: "ses", apiKeyId: owner.row.id, expiresAt: new Date(Date.now() + 30 * DAY) })
      .returning();

    await db.insert(rateLimits).values({ key: "aged-rl", windowStart: new Date(Date.now() - 2 * DAY), count: 5 });
    await db.insert(rateLimits).values({ key: "fresh-rl", count: 1 });

    for (const v of RETENTION_VARS) process.env[v] = "7";
    const result = await runRetentionSweep();

    expect(result.hitsDeleted).toBeGreaterThanOrEqual(1);
    expect(result.notificationsDeleted).toBeGreaterThanOrEqual(1);
    expect(result.auditEventsDeleted).toBeGreaterThanOrEqual(1);
    expect(result.sessionsDeleted).toBeGreaterThanOrEqual(1);
    expect(result.rateLimitsDeleted).toBeGreaterThanOrEqual(1);

    expect(await exists(db.select().from(hits).where(eq(hits.id, agedHit!.id)).limit(1))).toBe(false);
    expect(await exists(db.select().from(hits).where(eq(hits.id, freshHit!.id)).limit(1))).toBe(true);
    expect(await exists(db.select().from(notifications).where(eq(notifications.id, agedNotif!.id)).limit(1))).toBe(false);
    expect(await exists(db.select().from(notifications).where(eq(notifications.id, freshNotif!.id)).limit(1))).toBe(true);
    expect(await exists(db.select().from(auditEvents).where(eq(auditEvents.id, agedAudit!.id)).limit(1))).toBe(false);
    expect(await exists(db.select().from(auditEvents).where(eq(auditEvents.id, freshAudit!.id)).limit(1))).toBe(true);
    expect(await exists(db.select().from(sessions).where(eq(sessions.id, agedSession!.id)).limit(1))).toBe(false);
    expect(await exists(db.select().from(sessions).where(eq(sessions.id, activeSession!.id)).limit(1))).toBe(true);

    const rlKeys = (await db.select().from(rateLimits)).map((r) => r.key);
    expect(rlKeys).not.toContain("aged-rl");
    expect(rlKeys).toContain("fresh-rl");
  });

  it("purges spent rate_limits even with no retention env set", async () => {
    await db.insert(rateLimits).values({ key: "old-rl", windowStart: new Date(Date.now() - 2 * DAY), count: 3 });
    const result = await runRetentionSweep();
    expect(result.rateLimitsDeleted).toBeGreaterThanOrEqual(1);
    expect(result.hitsDeleted).toBe(0); // category off
    expect((await db.select().from(rateLimits)).map((r) => r.key)).not.toContain("old-rl");
  });

  it("audit_events is append-only: a bare DELETE is refused by the trigger", async () => {
    await db.insert(auditEvents).values({ eventType: "key.created" });
    let caught: { message?: string; cause?: { message?: string } } | undefined;
    try {
      await db.execute(sql`DELETE FROM audit_events`);
    } catch (e) {
      caught = e as typeof caught;
    }
    expect(caught).toBeDefined();
    // drizzle wraps the PostgresError; the trigger's message is on .cause.
    expect(caught!.cause?.message ?? caught!.message ?? "").toMatch(/append-only/i);
  });
});
