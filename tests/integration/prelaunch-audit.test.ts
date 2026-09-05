import { describe, it, expect, vi } from "vitest";

// Regression guards from the 2026-09-05 pre-launch audit. Each case was a
// confirmed defect on 42175e3; these assert the fixed behaviour.

vi.mock("@/lib/log", () => ({
  log: { info() {}, warn() {}, error() {}, debug() {}, fatal() {}, trace() {} },
}));

import { db } from "@/db/client";
import { hits, notificationDestinations } from "@/db/schema";
import { enqueueNotifications } from "@/lib/notify/enqueue";
import { GET as keyHits } from "@/app/api/keys/[id]/hits/route";
import { GET as recentHits } from "@/app/api/hits/recent/route";
import { POST as createKey } from "@/app/api/keys/route";
import { POST as createApiKey } from "@/app/api/api-keys/route";
import { GET as auditGet } from "@/app/api/audit/route";
import { seedApiKey, seedCanaryKey, buildJsonRequest, ctxParams } from "./_harness";

const SLACK_GLOBAL =
  "https://hooks.slack.com/services/T0000000/B0000000/ADMINSECRETTOKENxxxxxxxx";
const HA_GLOBAL = "https://ha.example.net/api/webhook/super-secret-ha-webhook-id";
const OWN_WEBHOOK = "https://127.0.0.1:9/own-hook";

type HitNotif = {
  channel: string;
  target: string | null;
  destination_scope: "key" | "global" | "unknown";
};

async function seedGlobals() {
  await db.insert(notificationDestinations).values([
    { keyId: null, channel: "slack", target: SLACK_GLOBAL },
    { keyId: null, channel: "home_assistant", target: HA_GLOBAL },
  ]);
}

describe("AUDIT-1 global destination targets are redacted for non-admins", () => {
  it("GET /api/keys/:id/hits hides global targets from the key owner but keeps the key's own", async () => {
    await seedGlobals();
    const user = await seedApiKey();
    const key = await seedCanaryKey(user.row.id);
    await db
      .insert(notificationDestinations)
      .values({ keyId: key.id, channel: "webhook", target: OWN_WEBHOOK });
    const [hit] = await db.insert(hits).values({ keyId: key.id, ip: "203.0.113.9" }).returning();
    await enqueueNotifications(key, hit!);

    const res = await keyHits(
      buildJsonRequest(`/api/keys/${key.id}/hits`, { bearer: user.plaintext }),
      ctxParams({ id: key.id }),
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(SLACK_GLOBAL);
    expect(text).not.toContain(HA_GLOBAL);
    const body = JSON.parse(text) as { data: Array<{ notifications: HitNotif[] }> };
    const notifs = body.data[0]!.notifications;
    expect(notifs).toHaveLength(3);
    const own = notifs.find((n) => n.channel === "webhook")!;
    expect(own.target).toBe(OWN_WEBHOOK);
    expect(own.destination_scope).toBe("key");
    for (const n of notifs.filter((n) => n.channel !== "webhook")) {
      expect(n.target).toBeNull();
      expect(n.destination_scope).toBe("global");
    }
  });

  it("GET /api/hits/recent redacts for a non-admin and reveals for an admin", async () => {
    await seedGlobals();
    const user = await seedApiKey();
    const admin = await seedApiKey({ admin: true });
    const key = await seedCanaryKey(user.row.id);
    const [hit] = await db.insert(hits).values({ keyId: key.id }).returning();
    await enqueueNotifications(key, hit!);

    const asUser = await recentHits(
      buildJsonRequest(`/api/hits/recent`, { bearer: user.plaintext }),
    );
    expect(asUser.status).toBe(200);
    const userText = await asUser.text();
    expect(userText).not.toContain(SLACK_GLOBAL);
    const userBody = JSON.parse(userText) as { data: Array<{ notifications: HitNotif[] }> };
    expect(userBody.data[0]!.notifications.every((n) => n.target === null)).toBe(true);

    const asAdmin = await recentHits(
      buildJsonRequest(`/api/hits/recent`, { bearer: admin.plaintext }),
    );
    const adminBody = (await asAdmin.json()) as { data: Array<{ notifications: HitNotif[] }> };
    expect(adminBody.data[0]!.notifications.map((n) => n.target).sort()).toEqual(
      [HA_GLOBAL, SLACK_GLOBAL].sort(),
    );
  });

  it("a notification whose destination was deleted is redacted for non-admins", async () => {
    const user = await seedApiKey();
    const key = await seedCanaryKey(user.row.id);
    const [dest] = await db
      .insert(notificationDestinations)
      .values({ keyId: key.id, channel: "webhook", target: OWN_WEBHOOK })
      .returning();
    const [hit] = await db.insert(hits).values({ keyId: key.id }).returning();
    await enqueueNotifications(key, hit!);
    await db.delete(notificationDestinations).where(
      (await import("drizzle-orm")).eq(notificationDestinations.id, dest!.id),
    );

    const res = await keyHits(
      buildJsonRequest(`/api/keys/${key.id}/hits`, { bearer: user.plaintext }),
      ctxParams({ id: key.id }),
    );
    const body = (await res.json()) as { data: Array<{ notifications: HitNotif[] }> };
    expect(body.data[0]!.notifications[0]!.target).toBeNull();
    expect(body.data[0]!.notifications[0]!.destination_scope).toBe("unknown");
  });
});

describe("AUDIT-2 external_id claims by a non-owner are refused", () => {
  it("a different full key gets a bare 409 with no key details", async () => {
    const victim = await seedApiKey({ name: "victim" });
    const victimKey = await seedCanaryKey(victim.row.id, {
      memo: "victim laptop — ssh login alarm",
      externalId: "web01",
    });
    const attacker = await seedApiKey({ name: "attacker" });
    const res = await createKey(
      buildJsonRequest("/api/keys", {
        method: "POST",
        bearer: attacker.plaintext,
        body: { memo: "probe", external_id: "web01" },
      }),
    );
    expect(res.status).toBe(409);
    const text = await res.text();
    expect(text).not.toContain(victimKey.publicId);
    expect(text).not.toContain(victimKey.id);
    expect(text).not.toContain("victim laptop");
  });

  it("an enrollment-scoped key that did not create the key gets the URL but not the memo or routing", async () => {
    // Documented fleet flow (deploy/kandji): a re-imaged machine recovers its
    // trigger URL by serial under a rotated enroll key. Disclosure is limited
    // to what the device needs and the claim is audited as cross_key.
    const victim = await seedApiKey();
    const victimKey = await seedCanaryKey(victim.row.id, {
      externalId: "db02",
      memo: "secret memo text",
    });
    await db
      .insert(notificationDestinations)
      .values({ keyId: victimKey.id, channel: "webhook", target: OWN_WEBHOOK });
    const enroll = await seedApiKey({ scope: "enroll" });
    const res = await createKey(
      buildJsonRequest("/api/keys", {
        method: "POST",
        bearer: enroll.plaintext,
        body: { memo: "probe", external_id: "db02" },
      }),
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain(victimKey.publicId);
    expect(text).not.toContain("secret memo text");
    expect(text).not.toContain(OWN_WEBHOOK);
    const body = JSON.parse(text) as { memo: string | null; destinations?: unknown };
    expect(body.memo).toBeNull();
    expect(body.destinations).toBeUndefined();
  });

  it("the creator (enroll key) still gets its own key back on re-enrol", async () => {
    const enroll = await seedApiKey({ scope: "enroll" });
    const first = await createKey(
      buildJsonRequest("/api/keys", {
        method: "POST",
        bearer: enroll.plaintext,
        body: { memo: "mac-1", external_id: "SER1" },
      }),
    );
    expect(first.status).toBe(201);
    const again = await createKey(
      buildJsonRequest("/api/keys", {
        method: "POST",
        bearer: enroll.plaintext,
        body: { memo: "mac-1", external_id: "SER1" },
      }),
    );
    expect(again.status).toBe(200);
    expect(((await again.json()) as { reused: boolean }).reused).toBe(true);
  });
});

describe("AUDIT-3 /api/audit validates ?actor=", () => {
  it("returns 422 for a non-UUID actor", async () => {
    const admin = await seedApiKey({ admin: true });
    const res = await auditGet(
      buildJsonRequest(`/api/audit?actor=not-a-uuid`, { bearer: admin.plaintext }),
    );
    expect(res.status).toBe(422);
  });
});

describe("AUDIT-5 API-key minting is admin-only", () => {
  it("a non-admin cannot mint a non-admin or enroll key", async () => {
    const user = await seedApiKey();
    for (const body of [{ name: "sibling" }, { name: "fleet", scope: "enroll" }]) {
      const res = await createApiKey(
        buildJsonRequest("/api/api-keys", { method: "POST", bearer: user.plaintext, body }),
      );
      expect(res.status).toBe(403);
    }
  });

  it("an admin can still mint a non-admin and an enroll key", async () => {
    const admin = await seedApiKey({ admin: true });
    for (const body of [{ name: "operator" }, { name: "fleet", scope: "enroll" }]) {
      const res = await createApiKey(
        buildJsonRequest("/api/api-keys", { method: "POST", bearer: admin.plaintext, body }),
      );
      expect(res.status).toBe(201);
    }
  });
});

describe("AUDIT-8 bearer failures on session-or-key routes hit the limiter", () => {
  it("returns 429 after the failure window is exhausted", async () => {
    const bad = "mantis_live_notarealkeyxxxxxxxxxxxxxxxxxxx";
    let last = 0;
    for (let i = 0; i < 61; i++) {
      const res = await recentHits(buildJsonRequest("/api/hits/recent", { bearer: bad }));
      last = res.status;
    }
    expect(last).toBe(429);
  });
});
