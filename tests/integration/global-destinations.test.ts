import { describe, it, expect, vi } from "vitest";

// Global notification destinations (notification_destinations.key_id IS NULL):
// configured once in /settings/notifications, they fan out to EVERY key on top
// of that key's own destinations. These guard the three ways that can go
// wrong: a bulk-minted key with no destinations of its own going silent, a
// global row leaking into a key's own destination list, and a destination
// listed both globally and per-key double-paging the operator.

vi.mock("@/lib/log", () => ({
  log: { info() {}, warn() {}, error() {}, debug() {}, fatal() {}, trace() {} },
}));

import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { hits, notificationDestinations, notifications } from "@/db/schema";
import { enqueueNotifications } from "@/lib/notify/enqueue";
import { listDestinations, listGlobalDestinations } from "@/lib/notify/destinations";
import { seedApiKey, seedCanaryKey } from "./_harness";

/** Inserts a destination row directly — bypasses the activation ping. */
async function seedDestination(keyId: string | null, target: string) {
  const [row] = await db
    .insert(notificationDestinations)
    .values({ keyId, channel: "webhook", target })
    .returning();
  return row!;
}

async function seedKeyAndHit() {
  const owner = await seedApiKey();
  const key = await seedCanaryKey(owner.row.id);
  const [hit] = await db
    .insert(hits)
    .values({ keyId: key.id, ip: "203.0.113.1" })
    .returning();
  return { key, hit: hit! };
}

async function queuedTargets(hitId: string): Promise<string[]> {
  const rows = await db
    .select({ target: notifications.target })
    .from(notifications)
    .where(eq(notifications.hitId, hitId));
  return rows.map((r) => r.target).sort();
}

describe("global notification destinations", () => {
  it("notifies a key that has no destinations of its own", async () => {
    // The bulk-mint case: keys are created without per-key destinations and
    // would be silent tripwires if globals didn't apply.
    await seedDestination(null, "http://127.0.0.1:9/global");
    const { key, hit } = await seedKeyAndHit();

    await enqueueNotifications(key, hit);

    expect(await queuedTargets(hit.id)).toEqual(["http://127.0.0.1:9/global"]);
  });

  it("fans out to global AND per-key destinations together", async () => {
    await seedDestination(null, "http://127.0.0.1:9/global");
    const { key, hit } = await seedKeyAndHit();
    await seedDestination(key.id, "http://127.0.0.1:9/per-key");

    await enqueueNotifications(key, hit);

    expect(await queuedTargets(hit.id)).toEqual([
      "http://127.0.0.1:9/global",
      "http://127.0.0.1:9/per-key",
    ]);
  });

  it("sends once when the same target is both global and per-key", async () => {
    // Otherwise every alert arrives twice for anyone who set a webhook
    // globally and also pinned it on an important key.
    const target = "http://127.0.0.1:9/shared";
    await seedDestination(null, target);
    const { key, hit } = await seedKeyAndHit();
    await seedDestination(key.id, target);

    await enqueueNotifications(key, hit);

    expect(await queuedTargets(hit.id)).toEqual([target]);
  });

  it("prefers the key's own row when deduping, keeping its signing secret", async () => {
    const target = "http://127.0.0.1:9/shared";
    await seedDestination(null, target);
    const { key, hit } = await seedKeyAndHit();
    const own = await seedDestination(key.id, target);

    await enqueueNotifications(key, hit);

    const [row] = await db
      .select({ destinationId: notifications.destinationId })
      .from(notifications)
      .where(eq(notifications.hitId, hit.id));
    expect(row?.destinationId).toBe(own.id);
  });

  it("keeps global rows out of a key's own destination list", async () => {
    await seedDestination(null, "http://127.0.0.1:9/global");
    const { key } = await seedKeyAndHit();
    await seedDestination(key.id, "http://127.0.0.1:9/per-key");

    const own = await listDestinations(key.id);
    expect(own.map((d) => d.target)).toEqual(["http://127.0.0.1:9/per-key"]);

    const globals = await listGlobalDestinations();
    expect(globals.map((d) => d.target)).toEqual(["http://127.0.0.1:9/global"]);
  });

  it("enqueues nothing when neither global nor per-key destinations exist", async () => {
    const { key, hit } = await seedKeyAndHit();
    await enqueueNotifications(key, hit);
    expect(await queuedTargets(hit.id)).toEqual([]);
  });

  it("survives deletion of a key without touching globals", async () => {
    // key_id has ON DELETE CASCADE; a NULL key_id must not be swept up.
    await seedDestination(null, "http://127.0.0.1:9/global");
    const { key } = await seedKeyAndHit();
    await seedDestination(key.id, "http://127.0.0.1:9/per-key");

    const { keys } = await import("@/db/schema");
    await db.delete(keys).where(eq(keys.id, key.id));

    const globals = await listGlobalDestinations();
    expect(globals.map((d) => d.target)).toEqual(["http://127.0.0.1:9/global"]);
  });
});
