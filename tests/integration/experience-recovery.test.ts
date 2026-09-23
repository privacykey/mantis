import { describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

vi.mock("@/lib/log", () => ({
  log: { info() {}, warn() {}, error() {}, debug() {}, fatal() {}, trace() {} },
}));

import { GET as recentHits } from "@/app/api/hits/recent/route";
import { db } from "@/db/client";
import { hits, keys, notificationDestinations } from "@/db/schema";
import { createKeyWithDestinations, replaceDestinations } from "@/lib/notify/destinations";
import { buildJsonRequest, seedApiKey, seedCanaryKey } from "./_harness";

describe("experience recovery", () => {
  it("rolls back a new key when its destination cannot be stored", async () => {
    const owner = await seedApiKey();
    await expect(createKeyWithDestinations(
      { publicId: "rollback123", memo: "rollback", createdByApiKeyId: owner.row.id },
      [{ channel: "webhook", target: null as unknown as string }],
    )).rejects.toThrow();
    expect(await db.select().from(keys).where(eq(keys.publicId, "rollback123"))).toHaveLength(0);
  });

  it("keeps an unchanged destination's identity when another is removed", async () => {
    const owner = await seedApiKey();
    const key = await seedCanaryKey(owner.row.id);
    const [kept, removed] = await db.insert(notificationDestinations).values([
      { keyId: key.id, channel: "email", target: "keep@example.com", lastActivationStatus: "ok" },
      { keyId: key.id, channel: "email", target: "remove@example.com", lastActivationStatus: "ok" },
    ]).returning();

    const results = await replaceDestinations(key, [{ channel: "email", target: "keep@example.com" }]);
    expect(results.map((result) => result.destination.id)).toEqual([kept!.id]);
    expect(await db.select().from(notificationDestinations).where(eq(notificationDestinations.keyId, key.id))).toHaveLength(1);
    expect(removed!.id).not.toBe(kept!.id);
  });

  it("paginates hits sharing one millisecond without skipping them", async () => {
    const owner = await seedApiKey();
    const key = await seedCanaryKey(owner.row.id);
    const occurredAt = new Date("2026-09-23T10:11:12.345Z");
    const ids = [1, 2, 3, 4].map((n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`);
    await db.insert(hits).values(ids.map((id) => ({ id, keyId: key.id, occurredAt })));

    const first = await recentHits(buildJsonRequest(`/api/hits/recent?key_id=${key.id}&limit=2`, { bearer: owner.plaintext }));
    const page1 = await first.json() as { data: Array<{ id: string }>; next_cursor: string | null };
    const second = await recentHits(buildJsonRequest(`/api/hits/recent?key_id=${key.id}&limit=2&cursor=${encodeURIComponent(page1.next_cursor!)}`, { bearer: owner.plaintext }));
    const page2 = await second.json() as { data: Array<{ id: string }>; next_cursor: string | null };
    expect([...page1.data, ...page2.data].map((row) => row.id)).toEqual([...ids].reverse());
    expect(page2.next_cursor).toBeNull();
  });
});
