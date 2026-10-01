import { describe, it, expect, vi } from "vitest";

// E2E-19 — Monitor + /status round-trip against real Postgres: a latch monitor
// reads ok before a hit, trips to 503 after one, clears back to ok once
// /reset moves monitorResetAt past the hit; off/disabled/unknown keys are 404
// not_monitored.

vi.mock("@/lib/log", () => ({
  log: { info() {}, warn() {}, error() {}, debug() {}, fatal() {}, trace() {} },
}));

import { GET as status } from "@/app/status/[publicId]/route";
import { GET as dashboardStatus } from "@/app/api/keys/[id]/monitor/route";
import { POST as reset } from "@/app/api/keys/[id]/reset/route";
import { NextRequest } from "next/server";
import { db } from "@/db/client";
import { hits } from "@/db/schema";
import { seedApiKey, seedCanaryKey, buildJsonRequest, ctxParams } from "./_harness";

function statusReq(publicId: string): Promise<Response> {
  return status(
    new NextRequest(new URL(`http://localhost:3000/status/${publicId}`)),
    ctxParams({ publicId }),
  );
}

describe("E2E-19 monitor + status round-trip", () => {
  it("ok → tripped (503) → reset → ok", async () => {
    const owner = await seedApiKey();
    const key = await seedCanaryKey(owner.row.id, {
      publicId: "monlatch01",
      monitorMode: "latch",
    });

    // Before any hit: ok.
    const before = await statusReq("monlatch01");
    expect(before.status).toBe(200);
    expect(((await before.json()) as { status: string }).status).toBe("ok");

    // A hit trips a latch monitor.
    await db
      .insert(hits)
      .values({ keyId: key.id, occurredAt: new Date(Date.now() - 5_000) });
    const tripped = await statusReq("monlatch01");
    expect(tripped.status).toBe(503);
    const body = (await tripped.json()) as { status: string; tripped_at: string };
    expect(body.status).toBe("tripped");
    expect(body.tripped_at).toBeTruthy();

    // Reset (owner-authed) moves monitorResetAt past the hit → ok again.
    const resetRes = await reset(
      buildJsonRequest(`/api/keys/${key.id}/reset`, {
        method: "POST",
        bearer: owner.plaintext,
      }),
      ctxParams({ id: key.id }),
    );
    expect(resetRes.status).toBe(200);

    const after = await statusReq("monlatch01");
    expect(after.status).toBe(200);
    expect(((await after.json()) as { status: string }).status).toBe("ok");
  });

  it("off/disabled/unknown keys are 404 not_monitored", async () => {
    const owner = await seedApiKey();
    await seedCanaryKey(owner.row.id, { publicId: "monoff0001" }); // monitorMode default 'off'
    const disabled = await seedCanaryKey(owner.row.id, {
      publicId: "mondisab01",
      monitorMode: "latch",
      disabledAt: new Date(),
    });

    expect((await statusReq("monoff0001")).status).toBe(404);
    expect((await statusReq("mondisab01")).status).toBe(404);
    expect((await statusReq("nosuchkey99")).status).toBe(404);
    void disabled;
  });

  it("returns current dashboard state after a trip and window expiry, gated by ownership", async () => {
    const owner = await seedApiKey(); const stranger = await seedApiKey();
    const key = await seedCanaryKey(owner.row.id, { monitorMode: "window", monitorWindowSeconds: 30 });
    const read = (bearer = owner.plaintext) => dashboardStatus(buildJsonRequest(`/api/keys/${key.id}/monitor`, { bearer }), ctxParams({ id: key.id }));
    expect((await (await read()).json()).state).toBe("ok");
    const [hit] = await db.insert(hits).values({ keyId: key.id }).returning();
    expect((await (await read()).json()).state).toBe("tripped");
    const { eq } = await import("drizzle-orm");
    await db.update(hits).set({ occurredAt: new Date(Date.now() - 60_000) }).where(eq(hits.id, hit!.id));
    expect((await (await read()).json()).state).toBe("ok");
    expect((await read(stranger.plaintext)).status).toBe(404);
  });
});
