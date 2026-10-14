import { afterEach, describe, it, expect, vi } from "vitest";

// E2E-04 + E2E-05 — The public /c trigger pipeline against real Postgres.
//  - Disabled / expired / unknown keys are silent GIFs and record no hit;
//    a live key records exactly one hit.
//  - Notification-suppression DoS regression (commit ef4ca329): flooding key A
//    over its per-key cap on the no-trusted-IP path must NOT blind key B — the
//    "anon" bucket must not collapse every canary into one.
//  - Same invariant with a TRUSTED client IP: junk requests from an IP must not
//    silence a live canary that fires from that IP (one NAT egress).
//  - <trigger URL>/<appended path> records a hit through the same handler, for
//    any method, without becoming an existence oracle.

vi.mock("@/lib/log", () => ({
  log: { info() {}, warn() {}, error() {}, debug() {}, fatal() {}, trace() {} },
}));
import { GET as trigger } from "@/app/c/[publicId]/route";
import {
  DELETE as appendedDelete,
  GET as appendedGet,
  POST as appendedPost,
  PUT as appendedPut,
} from "@/app/c/[publicId]/[...rest]/route";
import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { hits, notificationDestinations, notifications } from "@/db/schema";
import { seedApiKey, seedCanaryKey, ctxParams } from "./_harness";

afterEach(() => vi.unstubAllEnvs());

// No trusted-IP headers ⇒ extractIp() returns null ⇒ every key shares the
// "anon" suffix, exactly the context the suppression fix protects.
function hit(publicId: string): Promise<Response> {
  const req = new NextRequest(new URL(`http://localhost:3000/c/${publicId}`), {
    method: "GET",
    headers: new Headers({ "user-agent": "it-trigger" }),
  });
  return trigger(req, ctxParams({ publicId }));
}

// Trusted-proxy context: the ingress writes X-Forwarded-For and it is pinned,
// so extractIp() returns `ip` — the egress address everything behind one NAT
// shares.
function trustForwardedFor(): void {
  vi.stubEnv("TRUST_PROXY_HEADERS", "1");
  vi.stubEnv("TRUSTED_IP_HEADER", "x-forwarded-for");
}

function hitFrom(ip: string, publicId: string, query = ""): Promise<Response> {
  const req = new NextRequest(
    new URL(`http://localhost:3000/c/${publicId}${query}`),
    {
      method: "GET",
      headers: new Headers({ "user-agent": "it-trigger", "x-forwarded-for": ip }),
    },
  );
  return trigger(req, ctxParams({ publicId }));
}

type AppendedHandler = typeof appendedGet;

// A tool that treats the bait URL as a base URL: <trigger URL>/<rest…>.
function hitAppended(
  handler: AppendedHandler,
  method: string,
  publicId: string,
  rest: string[],
  query = "",
): Promise<Response> {
  const req = new NextRequest(
    new URL(`http://localhost:3000/c/${publicId}/${rest.join("/")}${query}`),
    { method, headers: new Headers({ "user-agent": "aws-cli/2.37.7" }) },
  );
  return handler(req, { params: Promise.resolve({ publicId, rest }) });
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

  it("keeps the clone detector's ?l= / ?r= page context with the hit", async () => {
    const owner = await seedApiKey();
    const key = await seedCanaryKey(owner.row.id, { publicId: "clonekey01" });

    const page = "https://login.clone.example/sign-in?next=%2Fhome";
    const res = await hitFrom(
      "203.0.113.20",
      "clonekey01",
      `?l=${encodeURIComponent(page)}&r=${encodeURIComponent("https://t.example/x")}`,
    );
    expect(res.headers.get("content-type")).toBe("image/gif");

    const [row] = await db.select().from(hits).where(eq(hits.keyId, key.id));
    const stored = row!.headers as Record<string, string>;
    expect(stored["x-mantis-page-url"]).toBe(page);
    expect(stored["x-mantis-page-referrer"]).toBe("https://t.example/x");
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
    // 200 sequential captures: comfortably inside the default 20 s normally,
    // but not on a heavily loaded machine.
  }, 60_000);

  it("junk requests from an IP never silence a live canary firing from that IP", async () => {
    // The attacker and the canary share one trusted client IP (a foothold
    // behind the same NAT as the hosts the canaries are planted on).
    trustForwardedFor();
    const sharedIp = "203.0.113.50";

    const owner = await seedApiKey();
    const live = await seedCanaryKey(owner.row.id, {
      publicId: "natlivekey",
      responseKind: "json",
      responsePayload: { ok: true },
    });
    await db.insert(notificationDestinations).values({
      keyId: live.id,
      channel: "webhook",
      target: "https://notify.example/hook",
    });

    // 200 requests — well over the old 120/min per-IP budget — spent on ids
    // that cost nothing (malformed) or one indexed lookup (well-formed, unknown).
    for (let i = 0; i < 100; i++) {
      const malformed = await hitFrom(sharedIp, "x");
      expect(malformed.headers.get("content-type")).toBe("image/gif");
      const unknown = await hitFrom(sharedIp, "unknownid99");
      expect(unknown.headers.get("content-type")).toBe("image/gif");
    }

    // The genuine trigger, from the same IP, must be captured AND enqueued —
    // and answered with the key's real response, not the shed-path GIF.
    const res = await hitFrom(sharedIp, "natlivekey");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");

    const rows = await db.select().from(hits).where(eq(hits.keyId, live.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.ip).toBe(sharedIp);
    expect(rows[0]!.isDuplicate).toBe(false);

    const queued = await db
      .select()
      .from(notifications)
      .where(eq(notifications.hitId, rows[0]!.id));
    expect(queued).toHaveLength(1);
    expect(queued[0]!.status).toBe("pending");
  }, 60_000);
});

describe("E2E-22 a path appended to the trigger URL still fires the key", () => {
  it("records the hit for any method and keeps the appended path", async () => {
    const owner = await seedApiKey();
    const key = await seedCanaryKey(owner.row.id, {
      publicId: "awsbait001",
      responseKind: "json",
      responsePayload: { ok: true },
      dedupeWindowSeconds: 0,
    });

    // What the AWS CLI sends for a profile whose endpoint_url is the bait:
    // s3api list-objects-v2, head-object, put-object, delete-object, and a
    // lambda list-functions.
    const calls: Array<[AppendedHandler, string, string[], string]> = [
      [appendedGet, "GET", ["example-prod-uploads"], "?list-type=2&encoding-type=url"],
      [appendedGet, "HEAD", ["example-prod-uploads", "backup.sql"], ""],
      [appendedPut, "PUT", ["example-prod-uploads", "new.txt"], ""],
      [appendedDelete, "DELETE", ["example-prod-uploads", "new.txt"], ""],
      [appendedPost, "POST", ["2015-03-31", "functions"], ""],
    ];
    for (const [handler, method, rest, query] of calls) {
      const res = await hitAppended(handler, method, "awsbait001", rest, query);
      // The key's own response, exactly as the bare trigger URL answers.
      expect(res.status, method).toBe(200);
      expect(res.headers.get("content-type"), method).toContain("application/json");
      expect(await res.json(), method).toEqual({ ok: true });
    }

    const rows = await db.select().from(hits).where(eq(hits.keyId, key.id));
    expect(rows).toHaveLength(calls.length);
    const paths = rows.map(
      (r) => (r.headers as Record<string, string>)["x-mantis-request-path"],
    );
    expect(paths.sort()).toEqual(
      [
        "/2015-03-31/functions",
        "/example-prod-uploads",
        "/example-prod-uploads/backup.sql",
        "/example-prod-uploads/new.txt",
        "/example-prod-uploads/new.txt",
      ].sort(),
    );
  });

  it("answers exactly like the bare URL for unknown, disabled, expired and malformed ids", async () => {
    const owner = await seedApiKey();
    const disabled = await seedCanaryKey(owner.row.id, {
      publicId: "disabled02",
      responseKind: "json",
      responsePayload: { ok: true },
      disabledAt: new Date(),
    });
    const expired = await seedCanaryKey(owner.row.id, {
      publicId: "expired002",
      responseKind: "json",
      responsePayload: { ok: true },
      expiresAt: new Date(Date.now() - 60_000),
    });

    for (const pid of ["disabled02", "expired002", "unknownkey98", "x", "not a key!"]) {
      const bare = await hit(pid);
      const appended = await hitAppended(appendedGet, "GET", pid, ["health"]);
      // No existence oracle: both shapes give the same silent GIF.
      expect(appended.status, pid).toBe(bare.status);
      expect(appended.headers.get("content-type"), pid).toBe("image/gif");
      expect(bare.headers.get("content-type"), pid).toBe("image/gif");
      expect(Buffer.from(await appended.arrayBuffer())).toEqual(
        Buffer.from(await bare.arrayBuffer()),
      );
    }

    expect((await countHits(disabled.id)).length).toBe(0);
    expect((await countHits(expired.id)).length).toBe(0);
    expect(await db.select().from(hits)).toHaveLength(0);
  });

  it("shares the bare URL's dedupe window and per-key limiter", async () => {
    const owner = await seedApiKey();
    const key = await seedCanaryKey(owner.row.id, { publicId: "dedupekey1" });
    await db.insert(notificationDestinations).values({
      keyId: key.id,
      channel: "webhook",
      target: "https://notify.example/hook",
    });

    await hit("dedupekey1");
    await hitAppended(appendedGet, "GET", "dedupekey1", ["v1", "users"]);

    const rows = await db.select().from(hits).where(eq(hits.keyId, key.id));
    expect(rows).toHaveLength(2);
    // One primary + one duplicate inside the window ⇒ one notification.
    expect(rows.filter((r) => !r.isDuplicate)).toHaveLength(1);
    expect(await db.select().from(notifications)).toHaveLength(1);
  });
});
