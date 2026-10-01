import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";

const sender = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("@/lib/log", () => ({ log: { info() {}, warn() {}, error() {}, debug() {} } }));
vi.mock("@/lib/notify/senders", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/notify/senders")>(), send: sender.send,
}));
import { db } from "@/db/client";
import { hits, notificationDestinations, notifications } from "@/db/schema";
import { recordHitWithNotifications } from "@/lib/hits";
import { processBatch } from "@/lib/notify/worker";
import { GET as trigger } from "@/app/c/[publicId]/route";
import { buildJsonRequest, ctxParams, seedApiKey, seedCanaryKey, waitFor } from "./_harness";

beforeEach(() => sender.send.mockReset().mockResolvedValue(undefined));
afterEach(() => vi.restoreAllMocks());

async function seedDelivery() {
  const owner = await seedApiKey();
  const key = await seedCanaryKey(owner.row.id);
  await db.insert(notificationDestinations).values({ keyId: key.id, channel: "webhook", target: "https://notify.example/hook" });
  const hit = await recordHitWithNotifications(key, { ip: "1.1.1.1" });
  const [notification] = await db.select().from(notifications).where(eq(notifications.hitId, hit!.id));
  return { key, hit: hit!, notification: notification! };
}

describe("durable delivery", () => {
  it("rolls back a primary hit if queue insertion fails, then retries without suppression", async () => {
    const owner = await seedApiKey();
    const key = await seedCanaryKey(owner.row.id);
    await db.insert(notificationDestinations).values({ keyId: key.id, channel: "webhook", target: "https://queue-failure.example/hook" });
    await db.execute(sql`ALTER TABLE notifications ADD CONSTRAINT audit_queue_failure CHECK (target <> 'https://queue-failure.example/hook')`);
    try {
      await expect(recordHitWithNotifications(key, { ip: "1.1.1.1" })).rejects.toThrow();
      const response = await trigger(buildJsonRequest(`/c/${key.publicId}`), ctxParams({ publicId: key.publicId }));
      expect(response.status).toBe(503);
      expect(response.headers.get("retry-after")).toBe("1");
      expect(await db.select().from(hits)).toHaveLength(0);
      expect(await db.select().from(notifications)).toHaveLength(0);
    } finally {
      await db.execute(sql`ALTER TABLE notifications DROP CONSTRAINT audit_queue_failure`);
    }
    const hit = await recordHitWithNotifications(key, { ip: "1.1.1.1" });
    expect(hit?.isDuplicate).toBe(false);
    expect(await db.select().from(notifications)).toHaveLength(1);
  });

  it("serializes concurrent captures into one queued primary alert", async () => {
    const { key } = await seedDelivery();
    await Promise.all(Array.from({ length: 4 }, () => recordHitWithNotifications(key, { ip: "1.1.1.1" })));
    expect(await db.select().from(notifications)).toHaveLength(1);
    expect((await db.select().from(hits)).filter((hit) => !hit.isDuplicate)).toHaveLength(1);
  });

  it("recovers an expired claim and sends the stable delivery id", async () => {
    const { notification } = await seedDelivery();
    await db.update(notifications).set({ status: "in_flight", claimToken: crypto.randomUUID(), leaseUntil: new Date(0), attempts: 1 }).where(eq(notifications.id, notification.id));
    expect(await processBatch(10)).toBe(1);
    expect(sender.send.mock.calls[0]![1].deliveryId).toBe(notification.id);
    const [settled] = await db.select().from(notifications);
    expect(settled?.status).toBe("succeeded");
    expect(settled?.attempts).toBe(2);
    expect(settled?.claimToken).toBeNull();
  });

  it("leaves an unexpired claim with its current worker", async () => {
    const { notification } = await seedDelivery();
    await db.update(notifications).set({ status: "in_flight", claimToken: crypto.randomUUID(), leaseUntil: new Date(Date.now() + 60_000), attempts: 1 }).where(eq(notifications.id, notification.id));
    expect(await processBatch(10)).toBe(0);
    expect(sender.send).not.toHaveBeenCalled();
  });

  it.each([false, true])("fences a stale worker's late result (fails=%s)", async (fails) => {
    const { notification } = await seedDelivery();
    let finish!: () => void;
    sender.send.mockImplementationOnce(() => new Promise<void>((resolve, reject) => { finish = () => fails ? reject(new Error("late failure")) : resolve(); }));
    const first = processBatch(1);
    expect(await waitFor(() => sender.send.mock.calls.length === 1)).toBe(true);
    await db.update(notifications).set({ leaseUntil: new Date(0) }).where(eq(notifications.id, notification.id));
    expect(await processBatch(1)).toBe(1);
    finish(); await first;
    const [settled] = await db.select().from(notifications);
    expect(settled?.status).toBe("succeeded");
    expect(settled?.attempts).toBe(2);
    expect(settled?.lastError).toBeNull();
    expect(sender.send.mock.calls.map((call) => call[1].deliveryId)).toEqual([notification.id, notification.id]);
  });

  it("recovers legacy claims and bounds repeated claim interruptions", async () => {
    const { notification } = await seedDelivery();
    await db.update(notifications).set({ status: "in_flight", updatedAt: new Date(0), attempts: 1 }).where(eq(notifications.id, notification.id));
    expect(await processBatch(1)).toBe(1);
    await db.update(notifications).set({ status: "in_flight", leaseUntil: new Date(0), attempts: 5 }).where(eq(notifications.id, notification.id));
    expect(await processBatch(1)).toBe(0);
    const [settled] = await db.select().from(notifications);
    expect(settled?.status).toBe("failed");
    expect(settled?.lastError).toMatch(/lease expired/);
  });
});
