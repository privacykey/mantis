import { describe, it, expect, vi, afterEach } from "vitest";

// E2E-20 — Cron drain endpoint authorization (real Postgres). CRON_SECRET is
// captured at module load, so each case re-imports the route with the desired
// env. Fail-closed when unset, timing-safe bearer required, unauth probes
// throttled per IP, and a correct bearer drains pending notifications.
//
// E2E-23 — With the in-process worker off, this endpoint is also what applies
// the retention windows: an authorised call sweeps (about hourly, throttled
// through a shared slot), and a sweep failure never changes the response.

vi.mock("@/lib/log", () => ({
  log: { info() {}, warn() {}, error() {}, debug() {}, fatal() {}, trace() {} },
}));

import type { NextRequest } from "next/server";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { hits, notificationDestinations, notifications, rateLimits } from "@/db/schema";
import { seedApiKey, seedCanaryKey, buildJsonRequest } from "./_harness";
import { startSink, type Sink } from "./_sink";

const DAY = 86_400_000;
const CRON_TOKEN = "s3cr3t-cron-token";

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
  delete process.env.MANTIS_HIT_RETENTION_DAYS;
  vi.doUnmock("@/lib/retention");
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
    const [dest] = await db
      .insert(notificationDestinations)
      .values({ keyId: key.id, channel: "webhook", target: sink.url })
      .returning();
    const [n] = await db
      .insert(notifications)
      .values({
        hitId: hit!.id,
        keyId: key.id,
        destinationId: dest!.id,
        channel: "webhook",
        target: sink.url,
      })
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

describe("E2E-23 retention runs from the cron endpoint", () => {
  const call = (GET: (req: NextRequest) => Promise<Response>, bearer?: string) =>
    GET(buildJsonRequest("/api/cron/notifications", bearer ? { bearer } : {}));

  async function seedAgedHit(keyId: string) {
    const [row] = await db
      .insert(hits)
      .values({ keyId, occurredAt: new Date(Date.now() - 10 * DAY) })
      .returning();
    return row!;
  }

  const hitExists = async (id: string) =>
    (await db.select().from(hits).where(eq(hits.id, id)).limit(1)).length === 1;

  it("applies the retention window and the rate_limits TTL on an authorised call", async () => {
    process.env.MANTIS_HIT_RETENTION_DAYS = "1";
    const owner = await seedApiKey();
    const key = await seedCanaryKey(owner.row.id);
    const aged = await seedAgedHit(key.id);
    const [fresh] = await db.insert(hits).values({ keyId: key.id }).returning();
    await db
      .insert(rateLimits)
      .values({ key: "spent-rl", windowStart: new Date(Date.now() - 2 * DAY), count: 5 });

    const GET = await loadCron(CRON_TOKEN);
    const res = await call(GET, CRON_TOKEN);
    expect(res.status).toBe(200);
    // The delivery response is unchanged by the sweep.
    expect(await res.json()).toEqual({ processed: 0 });

    expect(await hitExists(aged.id)).toBe(false);
    expect(await hitExists(fresh!.id)).toBe(true);
    const rlKeys = (await db.select().from(rateLimits)).map((r) => r.key);
    expect(rlKeys).not.toContain("spent-rl");
  });

  it("does not sweep on an unauthorised call", async () => {
    process.env.MANTIS_HIT_RETENTION_DAYS = "1";
    const owner = await seedApiKey();
    const key = await seedCanaryKey(owner.row.id);
    const aged = await seedAgedHit(key.id);

    const GET = await loadCron(CRON_TOKEN);
    expect((await call(GET)).status).toBe(401);
    expect((await call(GET, "wrong-token")).status).toBe(401);
    expect(await hitExists(aged.id)).toBe(true);
  });

  it("sweeps at most once an hour, across instances, until the slot expires", async () => {
    process.env.MANTIS_HIT_RETENTION_DAYS = "1";
    const owner = await seedApiKey();
    const key = await seedCanaryKey(owner.row.id);
    const first = await seedAgedHit(key.id);

    const GET = await loadCron(CRON_TOKEN);
    expect((await call(GET, CRON_TOKEN)).status).toBe(200);
    expect(await hitExists(first.id)).toBe(false);

    // A per-minute cron: the next call on the same instance must not rescan.
    const second = await seedAgedHit(key.id);
    expect((await call(GET, CRON_TOKEN)).status).toBe(200);
    expect(await hitExists(second.id)).toBe(true);

    // Nor on a freshly started instance (serverless cold start / another
    // replica): the hourly slot lives in the shared rate_limits table.
    const coldStart = await loadCron(CRON_TOKEN);
    expect((await call(coldStart, CRON_TOKEN)).status).toBe(200);
    expect(await hitExists(second.id)).toBe(true);

    // Once the slot's hour has elapsed, the next instance to ask sweeps.
    await db.execute(
      sql`UPDATE rate_limits SET window_start = now() - interval '61 minutes' WHERE key = 'retention-sweep'`,
    );
    const later = await loadCron(CRON_TOKEN);
    expect((await call(later, CRON_TOKEN)).status).toBe(200);
    expect(await hitExists(second.id)).toBe(false);
  });

  it("a failing sweep is logged and never changes the delivery response", async () => {
    const sweep = vi.fn().mockRejectedValue(new Error("sweep exploded"));
    vi.resetModules();
    vi.doMock("@/lib/retention", () => ({ runRetentionSweepIfDue: sweep }));
    process.env.CRON_SECRET = CRON_TOKEN;
    const { GET } = await import("@/app/api/cron/notifications/route");

    const res = await call(GET, CRON_TOKEN);
    expect(sweep).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ processed: 0 });
  });
});
