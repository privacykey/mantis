import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// E2E-14 — Notification retry queue against real Postgres: a failing destination
// is retried with growing backoff then permanently failed at max_attempts (with
// status-line-only last_error — no body oracle), and concurrent workers never
// double-claim a row (FOR UPDATE SKIP LOCKED).

vi.mock("@/lib/log", () => ({
  log: { info() {}, warn() {}, error() {}, debug() {}, fatal() {}, trace() {} },
}));

import { processBatch } from "@/lib/notify";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { hits, notifications } from "@/db/schema";
import { seedApiKey, seedCanaryKey } from "./_harness";
import { startSink, type Sink } from "./_sink";

let sink: Sink | null = null;
beforeEach(() => {
  process.env.ALLOW_PRIVATE_WEBHOOKS = "1";
});
afterEach(async () => {
  delete process.env.ALLOW_PRIVATE_WEBHOOKS;
  if (sink) {
    await sink.close();
    sink = null;
  }
});

async function seedHit(): Promise<string> {
  const owner = await seedApiKey();
  const key = await seedCanaryKey(owner.row.id);
  const [hit] = await db.insert(hits).values({ keyId: key.id, ip: "1.1.1.1" }).returning();
  return hit!.id;
}

async function enqueueOne(hitId: string, target: string): Promise<string> {
  const [keyRow] = await db.select().from(hits).where(eq(hits.id, hitId)).limit(1);
  const [n] = await db
    .insert(notifications)
    .values({ hitId, keyId: keyRow!.keyId, channel: "webhook", target })
    .returning();
  return n!.id;
}

async function readNotification(id: string) {
  const [n] = await db.select().from(notifications).where(eq(notifications.id, id)).limit(1);
  return n!;
}

describe("E2E-14 notification retry queue", () => {
  it("retries with backoff, then permanently fails at max_attempts (no body oracle)", async () => {
    sink = await startSink({ status: 500, body: "BODY_ORACLE_LEAK_SECRET" });
    const hitId = await seedHit();
    const id = await enqueueOne(hitId, sink.url);

    // First failure → scheduled retry, not failed.
    expect(await processBatch(10)).toBe(1);
    let n = await readNotification(id);
    expect(n.status).toBe("pending");
    expect(n.attempts).toBe(1);
    expect(n.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
    expect(n.lastError).toMatch(/500/);
    expect(n.lastError).not.toContain("BODY_ORACLE_LEAK_SECRET");

    // Drive the remaining attempts (resetting the backoff clock each round).
    for (let i = 0; i < 4; i++) {
      await db.execute(
        sql`update notifications set next_attempt_at = now() where status = 'pending'`,
      );
      await processBatch(10);
    }

    n = await readNotification(id);
    expect(n.status).toBe("failed");
    expect(n.attempts).toBe(5);
    expect(n.lastError).not.toContain("BODY_ORACLE_LEAK_SECRET");
  });

  it("concurrent workers claim each row exactly once (SKIP LOCKED)", async () => {
    sink = await startSink({ status: 200 });
    const hitId = await seedHit();
    for (let i = 0; i < 6; i++) await enqueueOne(hitId, sink.url);

    const [a, b] = await Promise.all([processBatch(10), processBatch(10)]);
    expect(a + b).toBe(6);

    // Each pending row was delivered exactly once.
    expect(sink.requests).toHaveLength(6);
    const rows = await db.select().from(notifications);
    expect(rows.every((r) => r.status === "succeeded")).toBe(true);
  });
});
