import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

// Removing a destination withdraws it. Each queued notification carries its
// own copy of the target and signing secret, so deleting the destination row
// alone left the queue delivering the full hit payload to the withdrawn
// target for the rest of the retry schedule. Removal now aborts those rows in
// the same transaction — for a key's own destinations and for global ones.

const sender = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("@/lib/log", () => ({ log: { info() {}, warn() {}, error() {}, debug() {} } }));
vi.mock("@/lib/notify/senders", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/notify/senders")>(), send: sender.send,
}));

import { db } from "@/db/client";
import { hits, notificationDestinations, notifications, type Key } from "@/db/schema";
import { enqueueNotifications } from "@/lib/notify/enqueue";
import { replaceDestinations, replaceGlobalDestinations } from "@/lib/notify/destinations";
import { processBatch } from "@/lib/notify/worker";
import { GET as keyHits } from "@/app/api/keys/[id]/hits/route";
import { buildJsonRequest, ctxParams, seedApiKey, seedCanaryKey, waitFor } from "./_harness";

const WITHDRAWN = "https://withdrawn.example/hook";
const KEPT = "https://kept.example/hook";

beforeEach(() => sender.send.mockReset().mockResolvedValue(undefined));

/** Inserts a destination row directly — bypasses the activation ping. */
async function seedDestination(keyId: string | null, target: string) {
  const [row] = await db
    .insert(notificationDestinations)
    .values({ keyId, channel: "webhook", target })
    .returning();
  return row!;
}

async function seedHit(key: Key) {
  const [hit] = await db.insert(hits).values({ keyId: key.id, ip: "203.0.113.1" }).returning();
  await enqueueNotifications(key, hit!);
  return hit!;
}

async function rowsByTarget() {
  const rows = await db.select().from(notifications);
  return new Map(rows.map((r) => [r.target, r]));
}

const sentTargets = () => sender.send.mock.calls.map((call) => call[1].target as string);

describe("removed destinations stop receiving queued deliveries", () => {
  it("aborts a key's pending delivery when its destination is removed", async () => {
    const owner = await seedApiKey();
    const key = await seedCanaryKey(owner.row.id);
    await seedDestination(key.id, WITHDRAWN);
    await seedHit(key);

    await replaceDestinations(key, []);

    expect(await processBatch(10)).toBe(0);
    expect(sender.send).not.toHaveBeenCalled();
    const row = (await rowsByTarget()).get(WITHDRAWN)!;
    expect(row).toMatchObject({
      status: "aborted",
      lastError: "destination removed before delivery",
      claimToken: null,
      leaseUntil: null,
    });
  });

  it("aborts a delivery waiting on a retry, and leaves the kept destination's alone", async () => {
    const owner = await seedApiKey();
    const key = await seedCanaryKey(owner.row.id);
    await seedDestination(key.id, WITHDRAWN);
    await seedDestination(key.id, KEPT);
    await seedHit(key);
    // The usual reason to remove a destination: it has been failing.
    await db
      .update(notifications)
      .set({ attempts: 2, lastError: "HTTP 500 Internal Server Error", nextAttemptAt: new Date(Date.now() - 1000) })
      .where(eq(notifications.target, WITHDRAWN));

    await replaceDestinations(key, [{ channel: "webhook", target: KEPT }]);

    expect(await processBatch(10)).toBe(1);
    expect(sentTargets()).toEqual([KEPT]);
    const rows = await rowsByTarget();
    expect(rows.get(WITHDRAWN)!.status).toBe("aborted");
    expect(rows.get(KEPT)!.status).toBe("succeeded");
  });

  it("leaves settled deliveries as they were", async () => {
    const owner = await seedApiKey();
    const key = await seedCanaryKey(owner.row.id);
    await seedDestination(key.id, WITHDRAWN);
    await seedHit(key);
    expect(await processBatch(10)).toBe(1);

    await replaceDestinations(key, []);

    const row = (await rowsByTarget()).get(WITHDRAWN)!;
    expect(row.status).toBe("succeeded");
    expect(row.lastError).toBeNull();
  });

  it("fences a worker that already claimed the delivery", async () => {
    const owner = await seedApiKey();
    const key = await seedCanaryKey(owner.row.id);
    await seedDestination(key.id, WITHDRAWN);
    await seedHit(key);

    let finish!: () => void;
    sender.send.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    const inFlight = processBatch(1);
    expect(await waitFor(() => sender.send.mock.calls.length === 1)).toBe(true);

    // The request is already on the wire and cannot be recalled, but its
    // late completion must not resurrect the row, and nothing retries it.
    await replaceDestinations(key, []);
    finish();
    await inFlight;

    const row = (await rowsByTarget()).get(WITHDRAWN)!;
    expect(row.status).toBe("aborted");
    expect(await processBatch(10)).toBe(0);
    expect(sender.send).toHaveBeenCalledTimes(1);
  });

  it("aborts every key's pending delivery when a GLOBAL destination is removed", async () => {
    const owner = await seedApiKey();
    const first = await seedCanaryKey(owner.row.id);
    const second = await seedCanaryKey(owner.row.id);
    await seedDestination(null, WITHDRAWN);
    await seedDestination(null, KEPT);
    await seedHit(first);
    await seedHit(second);

    await replaceGlobalDestinations([{ channel: "webhook", target: KEPT }]);

    expect(await processBatch(10)).toBe(2);
    expect(sentTargets()).toEqual([KEPT, KEPT]);
    const rows = await db.select().from(notifications);
    expect(rows.filter((r) => r.target === WITHDRAWN).map((r) => r.status)).toEqual(["aborted", "aborted"]);
  });

  it("does not touch another key's deliveries to the same target", async () => {
    const owner = await seedApiKey();
    const edited = await seedCanaryKey(owner.row.id);
    const other = await seedCanaryKey(owner.row.id);
    await seedDestination(edited.id, WITHDRAWN);
    await seedDestination(other.id, WITHDRAWN);
    await seedHit(edited);
    const otherHit = await seedHit(other);

    await replaceDestinations(edited, []);

    expect(await processBatch(10)).toBe(1);
    expect(sender.send.mock.calls[0]![1].hit.id).toBe(otherHit.id);
  });

  it("tells the key owner why the delivery stopped", async () => {
    const owner = await seedApiKey();
    const key = await seedCanaryKey(owner.row.id);
    await seedDestination(key.id, WITHDRAWN);
    await seedHit(key);
    await replaceDestinations(key, []);

    const res = await keyHits(
      buildJsonRequest(`/api/keys/${key.id}/hits`, { bearer: owner.plaintext }),
      ctxParams({ id: key.id }),
    );
    const body = (await res.json()) as {
      data: Array<{ notifications: Array<{ status: string; last_error: string | null; target: string | null }> }>;
    };
    expect(body.data[0]!.notifications).toEqual([
      expect.objectContaining({
        status: "aborted",
        last_error: "destination removed before delivery",
        // The row can no longer be attributed to a destination of this key.
        target: null,
      }),
    ]);
  });
});
