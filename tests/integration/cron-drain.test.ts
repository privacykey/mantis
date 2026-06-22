import { describe, it, expect, vi, afterEach } from "vitest";

// E2E-20 — Cron drain endpoint authorization (real Postgres). CRON_SECRET is
// captured at module load, so each case re-imports the route with the desired
// env. Fail-closed when unset, timing-safe bearer required, unauth probes
// throttled per IP, and a correct bearer drains pending notifications.

vi.mock("@/lib/log", () => ({
  log: { info() {}, warn() {}, error() {}, debug() {}, fatal() {}, trace() {} },
}));

import type { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { hits, notifications } from "@/db/schema";
import { seedApiKey, seedCanaryKey, buildJsonRequest } from "./_harness";
import { startSink, type Sink } from "./_sink";

// Re-import the route under a chosen CRON_SECRET (it reads the env at load time).
async function loadCron(secret: string | null) {
  vi.resetModules();
  if (secret === null) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = secret;
  const mod = await import("@/app/api/cron/notifications/route");
  return mod.GET as (req: NextRequest) => Promise<Response>;
}

let sink: Sink | null = null;
afterEach(async () => {
  delete process.env.CRON_SECRET;
  delete process.env.ALLOW_PRIVATE_WEBHOOKS;
  delete process.env.TRUST_PROXY_HEADERS;
  if (sink) {
    await sink.close();
    sink = null;
  }
});

describe("E2E-20 cron drain authorization", () => {
  it("fails closed (401) when CRON_SECRET is unset", async () => {
    const GET = await loadCron(null);
    const res = await GET(buildJsonRequest("/api/cron/notifications"));
    expect(res.status).toBe(401);
  });

  it("rejects missing or wrong bearer when CRON_SECRET is set", async () => {
    const GET = await loadCron("s3cr3t-cron-token");
    expect((await GET(buildJsonRequest("/api/cron/notifications"))).status).toBe(401);
    expect(
      (await GET(buildJsonRequest("/api/cron/notifications", { bearer: "wrong-token" }))).status,
    ).toBe(401);
  });

  it("throttles unauthenticated probes per IP (429 after the cap)", async () => {
    process.env.TRUST_PROXY_HEADERS = "1";
    const GET = await loadCron("s3cr3t-cron-token");
    const headers = { "cf-connecting-ip": "198.51.100.42" };
    for (let i = 0; i < 10; i++) {
      const res = await GET(buildJsonRequest("/api/cron/notifications", { headers }));
      expect(res.status).toBe(401);
    }
    const throttled = await GET(buildJsonRequest("/api/cron/notifications", { headers }));
    expect(throttled.status).toBe(429);
    expect(throttled.headers.get("retry-after")).toBeTruthy();
  });

  it("drains pending notifications with a correct bearer", async () => {
    process.env.ALLOW_PRIVATE_WEBHOOKS = "1";
    sink = await startSink({ status: 200 });

    const owner = await seedApiKey();
    const key = await seedCanaryKey(owner.row.id);
    const [hit] = await db.insert(hits).values({ keyId: key.id, ip: "1.1.1.1" }).returning();
    const [n] = await db
      .insert(notifications)
      .values({ hitId: hit!.id, keyId: key.id, channel: "webhook", target: sink.url })
      .returning();

    const GET = await loadCron("s3cr3t-cron-token");
    const res = await GET(
      buildJsonRequest("/api/cron/notifications", { bearer: "s3cr3t-cron-token" }),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { processed: number }).processed).toBeGreaterThanOrEqual(1);

    expect(sink.requests).toHaveLength(1);
    const [row] = await db.select().from(notifications).where(eq(notifications.id, n!.id)).limit(1);
    expect(row!.status).toBe("succeeded");
  });
});
