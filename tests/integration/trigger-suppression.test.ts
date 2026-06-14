import { describe, it, expect, vi } from "vitest";

// E2E-04 + E2E-05 — The public /c trigger pipeline against real Postgres.
//  - Disabled / expired / unknown keys are silent GIFs and record no hit;
//    a live key records exactly one hit.
//  - Notification-suppression DoS regression (commit ef4ca329): flooding key A
//    over its per-key cap on the no-trusted-IP path must NOT blind key B — the
//    "anon" bucket must not collapse every canary into one.

vi.mock("@/lib/log", () => ({
  log: { info() {}, warn() {}, error() {}, debug() {}, fatal() {}, trace() {} },
}));
// after() callbacks (the notify enqueue) don't auto-flush outside a Next request
// scope; no-op them so the synchronous hit recording is what we assert on.
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return { ...actual, after: (_fn: unknown) => {} };
});

import { GET as trigger } from "@/app/c/[publicId]/route";
import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { hits } from "@/db/schema";
import { seedApiKey, seedCanaryKey, ctxParams } from "./_harness";

// No trusted-IP headers ⇒ extractIp() returns null ⇒ the per-IP gate is skipped
// (fail-open), exactly the context the suppression fix protects.
function hit(publicId: string): Promise<Response> {
  const req = new NextRequest(new URL(`http://localhost:3000/c/${publicId}`), {
    method: "GET",
    headers: new Headers({ "user-agent": "it-trigger" }),
  });
  return trigger(req, ctxParams({ publicId }));
}

function countHits(keyId: string): Promise<{ length: number }> {
  return db.select().from(hits).where(eq(hits.keyId, keyId));
}

describe("E2E-04 trigger lifecycle silence", () => {
  it("records a hit only for the live key; disabled/expired/unknown are silent GIFs", async () => {
    const owner = await seedApiKey();
    const live = await seedCanaryKey(owner.row.id, {
      publicId: "livejson01",
      responseKind: "json",
      responsePayload: { ok: true },
      dedupeWindowSeconds: 0,
    });
    const disabled = await seedCanaryKey(owner.row.id, {
      publicId: "disabled01",
      disabledAt: new Date(),
    });
    const expired = await seedCanaryKey(owner.row.id, {
      publicId: "expired001",
      expiresAt: new Date(Date.now() - 60_000),
    });

    const liveRes = await hit("livejson01");
    expect(liveRes.status).toBe(200);
    expect(liveRes.headers.get("content-type")).toContain("application/json");

    for (const pid of ["disabled01", "expired001", "unknownkey99"]) {
      const res = await hit(pid);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("image/gif");
    }

    expect((await countHits(live.id)).length).toBe(1);
    expect((await countHits(disabled.id)).length).toBe(0);
    expect((await countHits(expired.id)).length).toBe(0);
  });
});

describe("E2E-05 flood of one canary does not blind another", () => {
  it("flooding key A on the no-IP path leaves key B fully recording", async () => {
    const owner = await seedApiKey();
    const a = await seedCanaryKey(owner.row.id, {
      publicId: "floodkeyaa",
      responseKind: "json",
      responsePayload: { ok: true },
      dedupeWindowSeconds: 0,
    });
    const b = await seedCanaryKey(owner.row.id, {
      publicId: "floodkeybb",
      responseKind: "json",
      responsePayload: { ok: true },
      dedupeWindowSeconds: 0,
    });

    // Flood A past its per-key window cap (120/min). Over-cap requests still get
    // A's REAL response (never a GIF substitution) — they just stop recording.
    for (let i = 0; i < 200; i++) {
      const res = await hit("floodkeyaa");
      expect(res.headers.get("content-type")).toContain("application/json");
    }

    // B, hit once from the same (missing-IP) context, must still record.
    const bRes = await hit("floodkeybb");
    expect(bRes.status).toBe(200);

    const aHits = await countHits(a.id);
    const bHits = await countHits(b.id);
    // A is bounded by its own bucket (≤120), B is untouched by A's flood.
    expect(aHits.length).toBeGreaterThan(0);
    expect(aHits.length).toBeLessThanOrEqual(120);
    expect(bHits.length).toBe(1);
  });
});
