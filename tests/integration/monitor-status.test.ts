import { describe, it, expect, vi } from "vitest";

// E2E-19 — Monitor + /status round-trip against real Postgres: a latch monitor
// reads ok before a hit, trips to 503 after one, clears back to ok once
// /reset moves monitorResetAt past the hit. The state is served only at
// /status/<publicId>.<tag>; the bare public id (the bait), a wrong tag, and
// off/disabled/unknown keys all get the same body-less 404.

vi.mock("@/lib/log", () => ({
  log: { info() {}, warn() {}, error() {}, debug() {}, fatal() {}, trace() {} },
}));

import { GET as status } from "@/app/status/[publicId]/route";
import { GET as dashboardStatus } from "@/app/api/keys/[id]/monitor/route";
import { POST as reset } from "@/app/api/keys/[id]/reset/route";
import { GET as getKey } from "@/app/api/keys/[id]/route";
import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { auditEvents, hits } from "@/db/schema";
import { statusTag, statusUrl } from "@/lib/env";
import { seedApiKey, seedCanaryKey, buildJsonRequest, ctxParams } from "./_harness";

/** GETs /status/<token>, where token is the whole last path segment. */
function statusReq(token: string): Promise<Response> {
  return status(
    new NextRequest(new URL(`http://localhost:3000/status/${token}`)),
    ctxParams({ publicId: token }),
  );
}

/** The capability URL's last segment, as statusUrl() mints it. */
function tokenFor(publicId: string): string {
  return `${publicId}.${statusTag(publicId)}`;
}

async function expectBareNotFound(res: Response): Promise<void> {
  expect(res.status).toBe(404);
  expect(await res.text()).toBe("");
  expect([...res.headers.entries()]).toEqual([["cache-control", "no-store"]]);
}

describe("E2E-19 monitor + status round-trip", () => {
  it("ok → tripped (503) → reset → ok", async () => {
    const owner = await seedApiKey();
    const key = await seedCanaryKey(owner.row.id, {
      publicId: "monlatch01",
      monitorMode: "latch",
    });
    const token = tokenFor("monlatch01");

    // Before any hit: ok.
    const before = await statusReq(token);
    expect(before.status).toBe(200);
    expect(await before.json()).toEqual({ status: "ok" });

    // A hit trips a latch monitor.
    await db
      .insert(hits)
      .values({ keyId: key.id, occurredAt: new Date(Date.now() - 5_000) });
    const tripped = await statusReq(token);
    expect(tripped.status).toBe(503);
    // Status only: when it tripped and in which mode stay behind the
    // owner-gated /api/keys/:id/monitor.
    expect(await tripped.json()).toEqual({ status: "tripped" });

    // Reset (owner-authed) moves monitorResetAt past the hit → ok again.
    const resetRes = await reset(
      buildJsonRequest(`/api/keys/${key.id}/reset`, {
        method: "POST",
        bearer: owner.plaintext,
      }),
      ctxParams({ id: key.id }),
    );
    expect(resetRes.status).toBe(200);

    const after = await statusReq(token);
    expect(after.status).toBe(200);
    expect(await after.json()).toEqual({ status: "ok" });
  });

  it("reports the newest hit when a key has many", async () => {
    const owner = await seedApiKey();
    const key = await seedCanaryKey(owner.row.id, { monitorMode: "latch" });
    const newest = new Date(Date.now() - 1_000);
    await db.insert(hits).values([
      { keyId: key.id, occurredAt: new Date(Date.now() - 90_000) },
      { keyId: key.id, occurredAt: newest },
      { keyId: key.id, occurredAt: new Date(Date.now() - 30_000) },
    ]);
    const res = await dashboardStatus(
      buildJsonRequest(`/api/keys/${key.id}/monitor`, { bearer: owner.plaintext }),
      ctxParams({ id: key.id }),
    );
    expect((await res.json()).tripped_at).toBe(newest.toISOString());
  });

  it("the bait id alone, or a wrong tag, reads nothing — same 404 as an unknown path", async () => {
    const owner = await seedApiKey();
    const key = await seedCanaryKey(owner.row.id, {
      publicId: "monlatch02",
      monitorMode: "latch",
    });
    await db.insert(hits).values({ keyId: key.id });

    // A tripped, monitored key: the old URL would have answered 503 + tripped_at.
    await expectBareNotFound(await statusReq("monlatch02"));
    await expectBareNotFound(await statusReq(`monlatch02.${statusTag("monlatch03")}`));
    await expectBareNotFound(await statusReq(`monlatch02.${"A".repeat(22)}`));
    // The capability still works.
    expect((await statusReq(tokenFor("monlatch02"))).status).toBe(503);
  });

  it("off/disabled/unknown keys are the same body-less 404, even with a valid tag", async () => {
    const owner = await seedApiKey();
    await seedCanaryKey(owner.row.id, { publicId: "monoff0001" }); // monitorMode default 'off'
    await seedCanaryKey(owner.row.id, {
      publicId: "mondisab01",
      monitorMode: "latch",
      disabledAt: new Date(),
    });

    await expectBareNotFound(await statusReq(tokenFor("monoff0001")));
    await expectBareNotFound(await statusReq(tokenFor("mondisab01")));
    await expectBareNotFound(await statusReq(tokenFor("nosuchkey99")));
  });

  it("the key's monitor_status_url is the capability URL", async () => {
    const owner = await seedApiKey();
    const key = await seedCanaryKey(owner.row.id, {
      publicId: "monlatch04",
      monitorMode: "latch",
    });
    const res = await getKey(
      buildJsonRequest(`/api/keys/${key.id}`, { bearer: owner.plaintext }),
      ctxParams({ id: key.id }),
    );
    const body = (await res.json()) as { monitor_status_url: string };
    expect(body.monitor_status_url).toBe(statusUrl("monlatch04"));
    const token = new URL(body.monitor_status_url).pathname.replace("/status/", "");
    expect(token).not.toBe("monlatch04");
    expect((await statusReq(token)).status).toBe(200);
  });

  it("returns current dashboard state after a trip and window expiry, gated by ownership", async () => {
    const owner = await seedApiKey(); const stranger = await seedApiKey();
    const key = await seedCanaryKey(owner.row.id, { monitorMode: "window", monitorWindowSeconds: 30 });
    const read = (bearer = owner.plaintext) => dashboardStatus(buildJsonRequest(`/api/keys/${key.id}/monitor`, { bearer }), ctxParams({ id: key.id }));
    expect((await (await read()).json()).state).toBe("ok");
    const [hit] = await db.insert(hits).values({ keyId: key.id }).returning();
    expect((await (await read()).json()).state).toBe("tripped");
    await db.update(hits).set({ occurredAt: new Date(Date.now() - 60_000) }).where(eq(hits.id, hit!.id));
    expect((await (await read()).json()).state).toBe("ok");
    expect((await read(stranger.plaintext)).status).toBe(404);
  });
});

// Clearing a tripped tripwire is exactly what an intruder holding a stolen key
// would do, so the API reset (the path `mantis reset` uses) leaves the same
// audit row the dashboard's reset action does.
describe("POST /api/keys/:id/reset is audited", () => {
  it("writes one monitor.reset row with the actor and key", async () => {
    const owner = await seedApiKey({ name: "ops laptop" });
    const key = await seedCanaryKey(owner.row.id, { monitorMode: "latch" });

    const res = await reset(
      buildJsonRequest(`/api/keys/${key.id}/reset`, { method: "POST", bearer: owner.plaintext }),
      ctxParams({ id: key.id }),
    );
    expect(res.status).toBe(200);

    const rows = await db.select().from(auditEvents).where(eq(auditEvents.eventType, "monitor.reset"));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorApiKeyId: owner.row.id,
      actorLabel: "ops laptop",
      subjectKind: "key",
      subjectId: key.id,
      metadata: { via: "api" },
    });
  });

  it("writes nothing when the caller does not own the key", async () => {
    const owner = await seedApiKey();
    const stranger = await seedApiKey();
    const key = await seedCanaryKey(owner.row.id, { monitorMode: "latch" });

    const res = await reset(
      buildJsonRequest(`/api/keys/${key.id}/reset`, { method: "POST", bearer: stranger.plaintext }),
      ctxParams({ id: key.id }),
    );
    expect(res.status).toBe(404);
    expect(await db.select().from(auditEvents).where(eq(auditEvents.eventType, "monitor.reset"))).toHaveLength(0);
  });
});
