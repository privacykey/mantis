import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";

// What an extracted enrollment key, or a key from another fleet, can do to a
// device's tripwire. An enroll key ships on every managed machine, so it may
// only mint inert canaries: never choose lifecycle, trigger content or alert
// routing, and never have a device adopt a key that someone outside the fleet
// created first.

vi.mock("@/lib/log", () => ({
  log: { info() {}, warn() {}, error() {}, debug() {}, fatal() {}, trace() {} },
}));

import { POST as createKey, GET as listKeys } from "@/app/api/keys/route";
import { PATCH as patchKey } from "@/app/api/keys/[id]/route";
import {
  GET as listApiKeys,
  POST as createApiKey,
} from "@/app/api/api-keys/route";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { apiKeys, auditEvents, keys, notificationDestinations } from "@/db/schema";
import {
  buildJsonRequest,
  ctxParams,
  seedApiKey,
  seedCanaryKey,
} from "./_harness";
import { startSink, type Sink } from "./_sink";

let sink: Sink | null = null;

beforeAll(() => {
  process.env.ALLOW_PRIVATE_WEBHOOKS = "1";
});

afterAll(() => {
  delete process.env.ALLOW_PRIVATE_WEBHOOKS;
});

afterEach(async () => {
  delete process.env.MANTIS_ENROLL_DESTINATIONS;
  delete process.env.MANTIS_ENROLL_KEYS_PER_HOUR;
  if (sink) {
    await sink.close();
    sink = null;
  }
});

type Body = Record<string, unknown> & { id: string; reused?: boolean };

function post(bearer: string, body: unknown) {
  return createKey(buildJsonRequest("/api/keys", { method: "POST", bearer, body }));
}

async function claimAudit(subjectId: string) {
  return db
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.subjectId, subjectId))
    .then((rows) => rows.filter((r) => r.eventType === "key.claimed"));
}

describe("enrollment-scoped keys mint inert tripwires only", () => {
  it("accepts the Kandji body and nothing that sets lifecycle, monitoring or trigger content", async () => {
    const enroll = await seedApiKey({ scope: "enroll" });

    const ok = await post(enroll.plaintext, {
      memo: "Terminal opened — mac-01",
      external_id: "C02KANDJI1",
      response_kind: "empty",
      dedupe_window_seconds: 120,
    });
    expect(ok.status).toBe(201);

    const future = new Date(Date.now() + 86_400_000).toISOString();
    const refused: Array<Record<string, unknown>> = [
      { expires_at: future },
      { monitor_mode: "latch" },
      { monitor_window_seconds: 60 },
      { self_origins: ["https://own-site.test"] },
      { response_kind: "redirect", response_payload: { url: "https://evil.test/" } },
      { response_kind: "html", response_payload: { html: "<h1>hi</h1>" } },
      { response_kind: "json", response_payload: { a: 1 } },
      { response_payload: { url: "https://evil.test/" } },
      { dedupe_window_seconds: 601 },
      { external_id: "mantis:device:laptop:macos:ssh-login" },
      { adopt: true },
    ];
    for (const extra of refused) {
      const res = await post(enroll.plaintext, { memo: "probe", ...extra });
      expect(res.status, JSON.stringify(extra)).toBe(403);
      expect(((await res.json()) as { error: string }).error).toBe("forbidden");
    }
    // Explicit nulls mean "not set" and stay acceptable.
    const nulls = await post(enroll.plaintext, {
      memo: "nulls",
      expires_at: null,
      response_payload: null,
    });
    expect(nulls.status).toBe(201);

    const rows = await db.select().from(keys);
    expect(rows.map((r) => r.memo).sort()).toEqual(["Terminal opened — mac-01", "nulls"]);
  });

  it("refuses an already-expired key from any scope", async () => {
    const full = await seedApiKey();
    const enroll = await seedApiKey({ scope: "enroll" });
    const past = new Date(Date.now() - 60_000).toISOString();
    for (const bearer of [full.plaintext, enroll.plaintext]) {
      const res = await post(bearer, { memo: "dead on arrival", expires_at: past });
      expect(res.status).toBe(422);
    }
    expect(await db.select().from(keys)).toHaveLength(0);
  });

  it("only attaches destinations an admin approved, before anything is stored or sent", async () => {
    sink = await startSink();
    const enroll = await seedApiKey({ scope: "enroll" });
    const full = await seedApiKey();

    for (const dest of [
      { channel: "webhook", target: sink.url },
      { channel: "email", target: "victim@example.test" },
    ]) {
      const res = await post(enroll.plaintext, {
        memo: "spam relay",
        external_id: "RELAY1",
        destinations: [dest],
      });
      expect(res.status).toBe(403);
    }
    expect(await db.select().from(keys)).toHaveLength(0);
    expect(await db.select().from(notificationDestinations)).toHaveLength(0);
    expect(sink.requests).toHaveLength(0);

    // The approved pair still works (Option A in deploy/kandji), repeated
    // entries collapse to one row and one activation ping.
    process.env.MANTIS_ENROLL_DESTINATIONS = `slack:https://hooks.slack.test/x  webhook:${sink.url}`;
    const approved = await post(enroll.plaintext, {
      memo: "mac-02",
      external_id: "RELAY2",
      destinations: [
        { channel: "webhook", target: sink.url },
        { channel: "webhook", target: sink.url },
      ],
    });
    expect(approved.status).toBe(201);
    expect(await db.select().from(notificationDestinations)).toHaveLength(1);
    expect(sink.requests).toHaveLength(1);

    // Full-scope keys are not subject to the allowlist.
    delete process.env.MANTIS_ENROLL_DESTINATIONS;
    const fullRes = await post(full.plaintext, {
      memo: "operator key",
      destinations: [{ channel: "webhook", target: sink.url }],
    });
    expect(fullRes.status).toBe(201);
  });

  it("a pre-claimed serial still gets the approved destination when the real device enrolls", async () => {
    sink = await startSink();
    process.env.MANTIS_ENROLL_DESTINATIONS = `webhook:${sink.url}`;
    const admin = await seedApiKey({ admin: true });
    const enroll = await seedApiKey({ scope: "enroll", ownerId: admin.row.id });
    const approved = [{ channel: "webhook", target: sink.url }];

    // Someone holding the extracted enroll key claims the serial first, with
    // no destination, hoping the device's alarm ends up routed nowhere.
    const planted = await post(enroll.plaintext, { memo: "x", external_id: "PRE-1" });
    expect(planted.status).toBe(201);
    const key = (await planted.json()) as Body;
    expect(await db.select().from(notificationDestinations)).toHaveLength(0);

    // The real device enrolls with the destination the operator approved.
    const device = await post(enroll.plaintext, {
      memo: "mac-9",
      external_id: "PRE-1",
      destinations: approved,
    });
    expect(device.status).toBe(200);
    const dests = await db.select().from(notificationDestinations);
    expect(dests).toHaveLength(1);
    expect(dests[0]).toMatchObject({ keyId: key.id, channel: "webhook", target: sink.url });
    expect(sink.requests).toHaveLength(1);

    // Daily re-runs add nothing more.
    await post(enroll.plaintext, { memo: "mac-9", external_id: "PRE-1", destinations: approved });
    expect(await db.select().from(notificationDestinations)).toHaveLength(1);
    expect(sink.requests).toHaveLength(1);

    // A key the operator created is never changed by a claim.
    const preprovisioned = await seedCanaryKey(admin.row.id, { externalId: "OPS-9" });
    const claim = await post(enroll.plaintext, {
      memo: "x",
      external_id: "OPS-9",
      destinations: approved,
    });
    expect(claim.status).toBe(200);
    expect(
      await db
        .select()
        .from(notificationDestinations)
        .where(eq(notificationDestinations.keyId, preprovisioned.id)),
    ).toHaveLength(0);
  });

  it("caps how many new keys one enroll credential creates per hour; re-claims stay free", async () => {
    process.env.MANTIS_ENROLL_KEYS_PER_HOUR = "2";
    const enroll = await seedApiKey({ scope: "enroll" });
    expect((await post(enroll.plaintext, { memo: "a", external_id: "CAP-A" })).status).toBe(201);
    expect((await post(enroll.plaintext, { memo: "b", external_id: "CAP-B" })).status).toBe(201);

    const over = await post(enroll.plaintext, { memo: "c", external_id: "CAP-C" });
    expect(over.status).toBe(429);
    expect(over.headers.get("retry-after")).toBeTruthy();

    const reclaim = await post(enroll.plaintext, { memo: "a", external_id: "CAP-A" });
    expect(reclaim.status).toBe(200);
    expect(await db.select().from(keys)).toHaveLength(2);
  });
});

describe("external_id claims stay inside the claimer's fleet", () => {
  it("a key pre-created by an unrelated owner is never adopted by the fleet", async () => {
    const admin = await seedApiKey({ admin: true });
    const fleetEnroll = await seedApiKey({ scope: "enroll", ownerId: admin.row.id });
    const legacyEnroll = await seedApiKey({ scope: "enroll" });
    const outsider = await seedApiKey({ name: "outsider" });

    // The outsider guesses a serial and creates the key first, with its own
    // routing. It could read that key's hits and mute its alerts.
    const planted = await post(outsider.plaintext, {
      memo: "looks legit",
      external_id: "C02VICTIM1",
    });
    expect(planted.status).toBe(201);
    const plantedBody = (await planted.json()) as Body;

    for (const bearer of [fleetEnroll.plaintext, legacyEnroll.plaintext, admin.plaintext]) {
      const res = await post(bearer, { memo: "mac", external_id: "C02VICTIM1" });
      expect(res.status).toBe(409);
      const text = await res.text();
      expect(text).not.toContain(plantedBody.id);
      expect(text).not.toContain("looks legit");
    }
    const denied = await claimAudit(plantedBody.id);
    expect(denied).toHaveLength(3);
    for (const row of denied) {
      expect((row.metadata as { denied?: boolean }).denied).toBe(true);
    }

    // Only an explicit admin adopt takes it over, and that is audited.
    const adopt = await post(admin.plaintext, {
      memo: "mac",
      external_id: "C02VICTIM1",
      adopt: true,
    });
    expect(adopt.status).toBe(200);
    expect(((await adopt.json()) as Body).created_by_caller).toBe(false);
    const audits = await claimAudit(plantedBody.id);
    expect(audits.some((r) => (r.metadata as { adopted?: boolean }).adopted)).toBe(true);

    // adopt is an admin-only override.
    const stranger = await seedApiKey({ name: "stranger" });
    const tryAdopt = await post(stranger.plaintext, {
      memo: "mac",
      external_id: "C02VICTIM1",
      adopt: true,
    });
    expect(tryAdopt.status).toBe(403);
  });

  it("the operators' fleet keeps working: preprovision, device claim, enroll-key rotation", async () => {
    const admin = await seedApiKey({ admin: true });
    const otherAdmin = await seedApiKey({ admin: true, name: "admin-2" });
    const enrollA = await seedApiKey({ scope: "enroll", ownerId: admin.row.id });
    const enrollB = await seedApiKey({ scope: "enroll", ownerId: otherAdmin.row.id });

    // Option B: an admin pre-provisions, the device claims by serial.
    const pre = await post(admin.plaintext, { memo: "mac-10", external_id: "SER10" });
    expect(pre.status).toBe(201);
    const claim = await post(enrollA.plaintext, { memo: "x", external_id: "SER10" });
    expect(claim.status).toBe(200);
    const claimBody = (await claim.json()) as Body;
    expect(claimBody.reused).toBe(true);
    expect(claimBody.created_by_caller).toBe(false);
    expect(claimBody.memo).toBeNull();

    // Option A: a device self-enrolls; after rotation the new enroll key and
    // any admin still resolve the same key.
    const self = await post(enrollA.plaintext, { memo: "mac-11", external_id: "SER11" });
    expect(self.status).toBe(201);
    const again = await post(enrollA.plaintext, { memo: "mac-11", external_id: "SER11" });
    expect(again.status).toBe(200);
    expect(((await again.json()) as Body).created_by_caller).toBe(true);
    const rotated = await post(enrollB.plaintext, { memo: "x", external_id: "SER11" });
    expect(rotated.status).toBe(200);
    const adminClaim = await post(otherAdmin.plaintext, { memo: "x", external_id: "SER11" });
    expect(adminClaim.status).toBe(200);
    expect(((await adminClaim.json()) as Body).created_by_caller).toBe(false);
  });

  it("an enroll key bound to a non-admin owner claims that owner's keys and no one else's", async () => {
    const admin = await seedApiKey({ admin: true });
    const tenant = await seedApiKey({ name: "tenant" });
    const tenantEnroll = await seedApiKey({ scope: "enroll", ownerId: tenant.row.id });

    await seedCanaryKey(tenant.row.id, { externalId: "TENANT-1" });
    await seedCanaryKey(admin.row.id, { externalId: "OPS-1" });

    expect((await post(tenantEnroll.plaintext, { memo: "x", external_id: "TENANT-1" })).status).toBe(200);
    expect((await post(tenantEnroll.plaintext, { memo: "x", external_id: "OPS-1" })).status).toBe(409);
  });

  it("a disabled or expired key is never handed back as a healthy tripwire", async () => {
    const admin = await seedApiKey({ admin: true });
    const enroll = await seedApiKey({ scope: "enroll", ownerId: admin.row.id });
    const disabled = await seedCanaryKey(admin.row.id, {
      externalId: "DEAD-1",
      disabledAt: new Date(),
    });
    await seedCanaryKey(admin.row.id, {
      externalId: "DEAD-2",
      expiresAt: new Date(Date.now() - 1000),
    });

    for (const ext of ["DEAD-1", "DEAD-2"]) {
      for (const bearer of [enroll.plaintext, admin.plaintext]) {
        const res = await post(bearer, { memo: "x", external_id: ext });
        expect(res.status).toBe(409);
        expect(await res.text()).not.toContain(disabled.publicId);
      }
    }
    const audits = await claimAudit(disabled.id);
    expect(audits).toHaveLength(2);
    for (const row of audits) {
      expect(row.metadata).toMatchObject({ dead: true, denied: true });
    }
  });
});

describe("enroll keys carry their fleet owner", () => {
  it("defaults to the minting admin and can be bound to another active full key", async () => {
    const admin = await seedApiKey({ admin: true });
    const tenant = await seedApiKey({ name: "tenant" });
    const mint = (body: unknown) =>
      createApiKey(
        buildJsonRequest("/api/api-keys", { method: "POST", bearer: admin.plaintext, body }),
      );

    const dflt = await mint({ name: "fleet", scope: "enroll" });
    expect(dflt.status).toBe(201);
    expect(((await dflt.json()) as { owner_api_key_id: string }).owner_api_key_id).toBe(admin.row.id);

    const bound = await mint({ name: "tenant-fleet", scope: "enroll", owner_api_key_id: tenant.row.id });
    expect(bound.status).toBe(201);
    expect(((await bound.json()) as { owner_api_key_id: string }).owner_api_key_id).toBe(tenant.row.id);

    // Not for full keys, not an enroll key, not a revoked or unknown key.
    expect((await mint({ name: "full", owner_api_key_id: tenant.row.id })).status).toBe(422);
    const anEnroll = await seedApiKey({ scope: "enroll" });
    expect((await mint({ name: "x", scope: "enroll", owner_api_key_id: anEnroll.row.id })).status).toBe(422);
    await db.update(apiKeys).set({ revokedAt: new Date() }).where(eq(apiKeys.id, tenant.row.id));
    expect((await mint({ name: "x", scope: "enroll", owner_api_key_id: tenant.row.id })).status).toBe(422);
    expect(
      (await mint({ name: "x", scope: "enroll", owner_api_key_id: "00000000-0000-4000-8000-000000000000" })).status,
    ).toBe(422);

    const listed = await listApiKeys(buildJsonRequest("/api/api-keys", { bearer: admin.plaintext }));
    const rows = ((await listed.json()) as { data: Array<{ name: string; owner_api_key_id: string | null }> }).data;
    expect(rows.find((r) => r.name === "tenant-fleet")?.owner_api_key_id).toBe(tenant.row.id);
    expect(rows.find((r) => r.name === "admin")?.owner_api_key_id).toBeNull();
  });
});

describe("GET /api/keys?mine=1", () => {
  it("restricts an admin's listing to keys it created itself", async () => {
    const admin = await seedApiKey({ admin: true });
    const enroll = await seedApiKey({ scope: "enroll", ownerId: admin.row.id });
    const own = await seedCanaryKey(admin.row.id, { memo: "operator key" });
    await seedCanaryKey(enroll.row.id, { memo: "minted by a device" });

    const all = await listKeys(buildJsonRequest("/api/keys", { bearer: admin.plaintext }));
    expect(((await all.json()) as { data: unknown[] }).data).toHaveLength(2);

    const mine = await listKeys(buildJsonRequest("/api/keys?mine=1&limit=1", { bearer: admin.plaintext }));
    const body = (await mine.json()) as { data: Array<{ id: string }> };
    expect(body.data.map((k) => k.id)).toEqual([own.id]);
  });
});

describe("control characters are refused in operator-rendered text", () => {
  it("rejects them in memos and destination targets on create and update", async () => {
    const full = await seedApiKey();
    for (const memo of ["wipe\u001b[2Kline", "bell\u0007", "c1\u009b2K", "two\nlines"]) {
      expect((await post(full.plaintext, { memo })).status).toBe(422);
    }
    const bad = await post(full.plaintext, {
      memo: "fine",
      destinations: [{ channel: "webhook", target: "https://hooks.example.test/\u001b]0;x\u0007" }],
    });
    expect(bad.status).toBe(422);

    const key = await seedCanaryKey(full.row.id);
    const patch = await patchKey(
      buildJsonRequest(`/api/keys/${key.id}`, {
        method: "PATCH",
        bearer: full.plaintext,
        body: { memo: "esc\u001b[31m" },
      }),
      ctxParams({ id: key.id }),
    );
    expect(patch.status).toBe(422);
    // Ordinary Unicode text is untouched.
    expect((await post(full.plaintext, { memo: "Büro-Laptop — ssh ✓" })).status).toBe(201);
  });
});
