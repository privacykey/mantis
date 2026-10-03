import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";

// Every dashboard path that creates a key or changes how its alerts are
// routed or monitored writes the same audit record its API sibling does.

const session = vi.hoisted(() => ({
  current: null as null | { id: string; name: string; isAdmin: boolean; scope: "full" },
}));
vi.mock("@/lib/session", () => ({ getSessionApiKey: async () => session.current }));
vi.mock("@/lib/log", () => ({
  log: { info() {}, warn() {}, error() {}, debug() {}, fatal() {}, trace() {} },
}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`redirect:${to}`);
  },
}));

import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { auditEvents, keys } from "@/db/schema";
import {
  setDestinationsAction,
  setMonitorAction,
  setSelfOriginsAction,
} from "@/app/(app)/keys/actions";
import { createKeyAction } from "@/app/(app)/keys/new/actions";
import { bulkCreateAction } from "@/app/(app)/keys/bulk/actions";
import { deviceCreateAction } from "@/app/(app)/keys/device/actions";
import { deviceExternalId, getDeviceProfile } from "@mantis/core/device-profiles";
import { seedApiKey, seedCanaryKey } from "./_harness";
import { startSink, type Sink } from "./_sink";

let sink: Sink | null = null;

beforeAll(() => {
  process.env.ALLOW_PRIVATE_WEBHOOKS = "1";
});
afterAll(() => {
  delete process.env.ALLOW_PRIVATE_WEBHOOKS;
});
afterEach(async () => {
  session.current = null;
  if (sink) {
    await sink.close();
    sink = null;
  }
});

async function signIn(name = "operator") {
  const seeded = await seedApiKey({ name });
  session.current = { id: seeded.row.id, name, isAdmin: false, scope: "full" };
  return seeded;
}

function form(fields: Record<string, string | string[]>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    if (Array.isArray(v)) for (const item of v) f.append(k, item);
    else f.set(k, v);
  }
  return f;
}

async function events(type: string) {
  return db.select().from(auditEvents).where(eq(auditEvents.eventType, type));
}

describe("dashboard actions are audited", () => {
  it("createKeyAction records key.created", async () => {
    const me = await signIn();
    await expect(
      createKeyAction({}, form({ memo: "front door", response_kind: "gif" })),
    ).rejects.toThrow(/^redirect:\/keys\//);
    const [row] = await db.select().from(keys);
    const audits = await events("key.created");
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actorApiKeyId: me.row.id,
      actorLabel: "operator",
      subjectKind: "key",
      subjectId: row!.id,
    });
    expect(audits[0]!.metadata).toMatchObject({ memo: "front door", via: "dashboard" });
  });

  it("createKeyAction and bulkCreateAction refuse control characters", async () => {
    await signIn();
    expect(await createKeyAction({}, form({ memo: "wipe\u001b[2K" }))).toEqual({
      error: "memo must not contain control characters",
    });
    const bulk = await bulkCreateAction({}, form({ preset: "doc-pdf", names: "ok\nbad\u0007name" }));
    expect(bulk.error).toMatch(/control characters/);
    expect(await db.select().from(keys)).toHaveLength(0);
  });

  it("bulkCreateAction records one key.created per key", async () => {
    await signIn();
    const res = await bulkCreateAction({}, form({ preset: "doc-pdf", names: "one\ntwo\nthree" }));
    expect(res.created).toHaveLength(3);
    const audits = await events("key.created");
    expect(audits.map((a) => a.subjectId).sort()).toEqual(res.created!.map((c) => c.id).sort());
  });

  it("deviceCreateAction records created keys and refused claims", async () => {
    await signIn();
    const vectors = getDeviceProfile("linux").vectors.slice(0, 2);
    const ok = await deviceCreateAction(
      {},
      form({ os: "linux", device: "web01", vectors: vectors.map((v) => v.slug) }),
    );
    expect(ok.minted).toHaveLength(2);
    expect(await events("key.created")).toHaveLength(2);

    // Re-running reuses the same keys and adds no key.created rows.
    await deviceCreateAction({}, form({ os: "linux", device: "web01", vectors: vectors.map((v) => v.slug) }));
    expect(await events("key.created")).toHaveLength(2);

    const other = await seedApiKey({ name: "someone-else" });
    const theirs = await seedCanaryKey(other.row.id, {
      externalId: deviceExternalId("db01", "linux", vectors[0]!),
    });
    const refused = await deviceCreateAction(
      {},
      form({ os: "linux", device: "db01", vectors: [vectors[0]!.slug] }),
    );
    expect(refused.error).toMatch(/already in use/);
    const claims = await events("key.claimed");
    expect(claims).toHaveLength(1);
    expect(claims[0]!.subjectId).toBe(theirs.id);
    expect(claims[0]!.metadata).toMatchObject({ denied: true, via: "dashboard" });
  });

  it("setDestinationsAction records destinations.replaced without targets", async () => {
    sink = await startSink();
    const me = await signIn();
    const key = await seedCanaryKey(me.row.id);
    const res = await setDestinationsAction(
      {},
      form({ id: key.id, destination_count: "1", channel_0: "webhook", target_0: sink.url }),
    );
    expect(res).toEqual({ saved: true });
    const audits = await events("destinations.replaced");
    expect(audits).toHaveLength(1);
    expect(audits[0]!.subjectId).toBe(key.id);
    expect(audits[0]!.metadata).toEqual({ count: 1, channels: ["webhook"], via: "dashboard" });
    expect(JSON.stringify(audits[0]!.metadata)).not.toContain(sink.url);

    const bad = await setDestinationsAction(
      {},
      form({ id: key.id, destination_count: "1", channel_0: "webhook", target_0: "https://x.test/\u001b[2K" }),
    );
    expect(bad.error).toMatch(/control characters/);
  });

  it("setMonitorAction and setSelfOriginsAction record key.updated", async () => {
    const me = await signIn();
    const key = await seedCanaryKey(me.row.id);

    expect(
      await setMonitorAction({}, form({ id: key.id, monitor_mode: "latch", monitor_window_seconds: "300" })),
    ).toEqual({ saved: true });
    expect(
      await setSelfOriginsAction({}, form({ id: key.id, self_origins: "https://WWW.Own-Site.test/\nhttps://www.own-site.test" })),
    ).toEqual({ saved: true });

    const audits = await events("key.updated");
    expect(audits).toHaveLength(2);
    expect(audits.map((a) => (a.metadata as { fields: string[] }).fields).sort()).toEqual([
      ["monitorMode", "monitorWindowSeconds"],
      ["selfOrigins"],
    ]);
    const [row] = await db.select().from(keys).where(eq(keys.id, key.id));
    expect(row!.selfOrigins).toEqual(["https://www.own-site.test"]);
    expect(row!.monitorMode).toBe("latch");

    const bad = await setSelfOriginsAction({}, form({ id: key.id, self_origins: "not-an-origin" }));
    expect(bad.error).toMatch(/not a site origin/);
  });
});
