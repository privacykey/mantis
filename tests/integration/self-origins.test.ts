import { describe, it, expect, vi } from "vitest";

// A web canary planted on the operator's own pages (css-background, tracking
// pixel) fires on every page view. Those hits must not anchor the dedupe
// window or use up the duplicate cap, or the cloned site's hit never alerts.

vi.mock("@/lib/log", () => ({
  log: { info() {}, warn() {}, error() {}, debug() {}, fatal() {}, trace() {} },
}));

import { POST as createKey } from "@/app/api/keys/route";
import { PATCH as patchKey } from "@/app/api/keys/[id]/route";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { hits, keys, notificationDestinations, notifications } from "@/db/schema";
import { recordHitWithNotifications } from "@/lib/hits";
import { buildJsonRequest, ctxParams, seedApiKey, seedCanaryKey } from "./_harness";

function post(bearer: string, body: unknown) {
  return createKey(buildJsonRequest("/api/keys", { method: "POST", bearer, body }));
}

describe("self_origins", () => {
  it("is stored in URL.origin form on create and update", async () => {
    const owner = await seedApiKey();
    const res = await post(owner.plaintext, {
      memo: "site clone detector",
      self_origins: ["https://WWW.Own-Site.test/", "https://www.own-site.test/pricing?x=1", "http://own-site.test:80"],
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; self_origins: string[] };
    expect(body.self_origins).toEqual(["https://www.own-site.test", "http://own-site.test"]);

    const patch = await patchKey(
      buildJsonRequest(`/api/keys/${body.id}`, {
        method: "PATCH",
        bearer: owner.plaintext,
        body: { self_origins: ["https://shop.own-site.test:8443/"] },
      }),
      ctxParams({ id: body.id }),
    );
    expect(patch.status).toBe(200);
    expect(((await patch.json()) as { self_origins: string[] }).self_origins).toEqual([
      "https://shop.own-site.test:8443",
    ]);

    for (const bad of ["own-site.test", "javascript:alert(1)", "ftp://own-site.test"]) {
      const r = await post(owner.plaintext, { memo: "bad", self_origins: [bad] });
      expect(r.status, bad).toBe(422);
    }
  });

  it("own-site hits neither anchor the dedupe window nor hide a clone-site hit", async () => {
    const owner = await seedApiKey();
    const key = await seedCanaryKey(owner.row.id, {
      dedupeWindowSeconds: 60,
      selfOrigins: ["https://www.own-site.test"],
    });
    await db
      .insert(notificationDestinations)
      .values({ keyId: key.id, channel: "webhook", target: "https://hooks.example.test/x" });

    // More own-site page views than the duplicate cap would ever store.
    for (let i = 0; i < 11; i++) {
      const own = await recordHitWithNotifications(key, {
        referer: `https://www.own-site.test/page-${i}`,
        ip: "203.0.113.5",
      });
      expect(own).toBeNull();
    }
    expect(await db.select().from(hits)).toHaveLength(0);

    const clone = await recordHitWithNotifications(key, {
      referer: "https://clone.attacker.test/",
      ip: "198.51.100.9",
    });
    expect(clone).not.toBeNull();
    expect(clone!.isDuplicate).toBe(false);
    const queued = await db
      .select()
      .from(notifications)
      .where(eq(notifications.hitId, clone!.id));
    expect(queued).toHaveLength(1);

    // No Referer, or an unparseable one, is treated like any other hit.
    const bare = await recordHitWithNotifications(key, { ip: "198.51.100.10" });
    expect(bare?.isDuplicate).toBe(true);
    const junk = await recordHitWithNotifications(key, { referer: "not a url" });
    expect(junk?.isDuplicate).toBe(true);
  });

  it("a key without declared origins is unaffected", async () => {
    const owner = await seedApiKey();
    const key = await seedCanaryKey(owner.row.id, { dedupeWindowSeconds: 60 });
    const hit = await recordHitWithNotifications(key, {
      referer: "https://www.own-site.test/",
    });
    expect(hit?.isDuplicate).toBe(false);
    const [row] = await db.select().from(keys).where(eq(keys.id, key.id));
    expect(row!.selfOrigins).toEqual([]);
  });
});
