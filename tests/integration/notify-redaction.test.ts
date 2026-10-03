import { afterEach, describe, expect, it, vi } from "vitest";

// A global destination's URL is an admin credential, and a non-admin key owner
// never gets it as `target`. The delivery diagnostic (`last_error`) is
// destination-derived text too — a redirect Location that repeats the webhook
// path, an SMTP rejection naming the recipient — and used to be returned
// verbatim. It now follows the same visibility rule as the target.

vi.mock("@/lib/log", () => ({
  log: { info() {}, warn() {}, error() {}, debug() {}, fatal() {}, trace() {} },
}));

import { and, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { hits, notificationDestinations, notifications } from "@/db/schema";
import { enqueueNotifications } from "@/lib/notify/enqueue";
import { processBatch } from "@/lib/notify";
import { GET as keyHits } from "@/app/api/keys/[id]/hits/route";
import { GET as recentHits } from "@/app/api/hits/recent/route";
import { seedApiKey, seedCanaryKey, buildJsonRequest, ctxParams } from "./_harness";
import { startSink, type Sink } from "./_sink";

const HA_GLOBAL = "http://ha.example.net/api/webhook/super-secret-ha-webhook-id";
const EMAIL_GLOBAL = "soc-oncall@example.net";
const OWN_WEBHOOK = "https://own.example/hook-path-of-the-owner";

type HitNotif = {
  channel: string;
  target: string | null;
  destination_scope: "key" | "global" | "unknown";
  last_error: string | null;
};
type HitsBody = { data: Array<{ notifications: HitNotif[] }> };

let sink: Sink | null = null;
afterEach(async () => {
  delete process.env.ALLOW_PRIVATE_WEBHOOKS;
  if (sink) {
    await sink.close();
    sink = null;
  }
});

/** A non-admin's key with one own webhook, hit once, under two global destinations. */
async function seedFailedDeliveries() {
  await db.insert(notificationDestinations).values([
    { keyId: null, channel: "home_assistant", target: HA_GLOBAL },
    { keyId: null, channel: "email", target: EMAIL_GLOBAL },
  ]);
  const user = await seedApiKey();
  const admin = await seedApiKey({ admin: true });
  const key = await seedCanaryKey(user.row.id);
  await db
    .insert(notificationDestinations)
    .values({ keyId: key.id, channel: "webhook", target: OWN_WEBHOOK });
  const [hit] = await db.insert(hits).values({ keyId: key.id, ip: "203.0.113.9" }).returning();
  await enqueueNotifications(key, hit!);

  const fail = (channel: "home_assistant" | "email" | "webhook", lastError: string) =>
    db
      .update(notifications)
      .set({ status: "failed", attempts: 5, lastError })
      .where(and(eq(notifications.hitId, hit!.id), eq(notifications.channel, channel)));
  // What safePostJson used to store for an http → https upgrade redirect.
  await fail("home_assistant", `HTTP 308 redirect to ${HA_GLOBAL.replace("http:", "https:")} — refusing to follow`);
  await fail("email", `Can't send mail - all recipients were rejected: 550 <${EMAIL_GLOBAL}> mailbox unavailable`);
  await fail("webhook", `HTTP 301 redirect to ${OWN_WEBHOOK}/ — refusing to follow`);
  return { user, admin, key };
}

async function readBoth(key: { id: string }, bearer: string): Promise<{ text: string; notifs: HitNotif[] }[]> {
  const responses = [
    await keyHits(buildJsonRequest(`/api/keys/${key.id}/hits`, { bearer }), ctxParams({ id: key.id })),
    await recentHits(buildJsonRequest(`/api/hits/recent`, { bearer })),
  ];
  return Promise.all(
    responses.map(async (res) => {
      expect(res.status).toBe(200);
      const text = await res.text();
      return { text, notifs: (JSON.parse(text) as HitsBody).data[0]!.notifications };
    }),
  );
}

describe("last_error follows the target-visibility rule", () => {
  it("a non-admin owner gets the status of a failing global destination, never its text", async () => {
    const { user, key } = await seedFailedDeliveries();

    for (const { text, notifs } of await readBoth(key, user.plaintext)) {
      expect(text).not.toContain("super-secret-ha-webhook-id");
      expect(text).not.toContain("ha.example.net");
      expect(text).not.toContain(EMAIL_GLOBAL);

      const ha = notifs.find((n) => n.channel === "home_assistant")!;
      expect(ha).toMatchObject({
        target: null,
        destination_scope: "global",
        last_error: "HTTP 308 (details visible to admins)",
      });
      const email = notifs.find((n) => n.channel === "email")!;
      expect(email).toMatchObject({
        target: null,
        destination_scope: "global",
        last_error: "delivery failed (details visible to admins)",
      });
    }
  });

  it("the owner still reads the full diagnostic of the key's own destination", async () => {
    const { user, key } = await seedFailedDeliveries();
    for (const { notifs } of await readBoth(key, user.plaintext)) {
      expect(notifs.find((n) => n.channel === "webhook")).toMatchObject({
        target: OWN_WEBHOOK,
        destination_scope: "key",
        last_error: `HTTP 301 redirect to ${OWN_WEBHOOK}/ — refusing to follow`,
      });
    }
  });

  it("an admin still reads every diagnostic in full", async () => {
    const { admin, key } = await seedFailedDeliveries();
    for (const { text, notifs } of await readBoth(key, admin.plaintext)) {
      expect(text).toContain("super-secret-ha-webhook-id");
      expect(text).toContain(EMAIL_GLOBAL);
      expect(notifs.find((n) => n.channel === "home_assistant")!.target).toBe(HA_GLOBAL);
    }
  });

  it("Mantis's own lifecycle reasons are shown to everyone", async () => {
    const { user, key } = await seedFailedDeliveries();
    await db
      .update(notifications)
      .set({ status: "aborted", lastError: "key disabled before delivery" })
      .where(eq(notifications.channel, "home_assistant"));
    for (const { notifs } of await readBoth(key, user.plaintext)) {
      expect(notifs.find((n) => n.channel === "home_assistant")!.last_error).toBe(
        "key disabled before delivery",
      );
    }
  });
});

describe("a redirecting global destination, end to end", () => {
  it("stores the Location origin only, and shows the non-admin owner only the status", async () => {
    process.env.ALLOW_PRIVATE_WEBHOOKS = "1";
    sink = await startSink({
      redirectTo: "https://ha.example.net/api/webhook/super-secret-ha-webhook-id?token=abc",
    });
    await db.insert(notificationDestinations).values({ keyId: null, channel: "webhook", target: sink.url });
    const user = await seedApiKey();
    const admin = await seedApiKey({ admin: true });
    const key = await seedCanaryKey(user.row.id);
    const [hit] = await db.insert(hits).values({ keyId: key.id }).returning();
    await enqueueNotifications(key, hit!);

    expect(await processBatch(10)).toBe(1);

    const [row] = await db.select().from(notifications);
    expect(row!.lastError).toBe("HTTP 302 redirect to https://ha.example.net — refusing to follow");

    const [asUser] = await readBoth(key, user.plaintext);
    expect(asUser!.text).not.toContain("ha.example.net");
    expect(asUser!.notifs[0]!.last_error).toBe("HTTP 302 (details visible to admins)");

    const [asAdmin] = await readBoth(key, admin.plaintext);
    expect(asAdmin!.text).not.toContain("super-secret-ha-webhook-id");
    expect(asAdmin!.notifs[0]!.last_error).toBe(row!.lastError);
  });
});
