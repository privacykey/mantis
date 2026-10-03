import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";

// The settings → notifications server actions, against real Postgres:
//  - a global webhook's signing secret can be revealed and rotated by an
//    admin (and only an admin), so the receiver of every key's alerts can
//    actually verify X-Mantis-Signature; each reveal and rotation is audited;
//  - replacing the global destination set — which can silence or redirect
//    alerting for the whole instance — writes an audit row that names counts
//    and channels, never the targets (they are credentials).

const ctx = vi.hoisted(() => ({
  session: null as { id: string; name: string; isAdmin: boolean } | null,
  headers: {} as Record<string, string>,
}));

vi.mock("@/lib/log", () => ({
  log: { info() {}, warn() {}, error() {}, debug() {}, fatal() {}, trace() {} },
}));
vi.mock("@/lib/session", () => ({ getSessionApiKey: async () => ctx.session }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`NEXT_REDIRECT:${to}`);
  },
}));
vi.mock("next/headers", () => ({
  headers: async () => ({ get: (n: string) => ctx.headers[n.toLowerCase()] ?? null }),
}));

import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { auditEvents, hits, notificationDestinations, type AuditEvent } from "@/db/schema";
import {
  revealGlobalSigningSecretAction,
  rotateGlobalSigningSecretAction,
  saveGlobalDestinationsAction,
} from "@/app/(app)/settings/notifications/actions";
import { enqueueNotifications } from "@/lib/notify/enqueue";
import { fingerprintSecret, listGlobalDestinations } from "@/lib/notify/destinations";
import { processBatch } from "@/lib/notify";
import { seedApiKey, seedCanaryKey, type SeededApiKey } from "./_harness";
import { startSink, type Sink, type SinkRequest } from "./_sink";

let sink: Sink | null = null;
beforeEach(() => {
  process.env.ALLOW_PRIVATE_WEBHOOKS = "1"; // allow the loopback sink
  ctx.session = null;
  ctx.headers = {};
});
afterEach(async () => {
  delete process.env.ALLOW_PRIVATE_WEBHOOKS;
  delete process.env.MANTIS_SECRET_KEY;
  if (sink) {
    await sink.close();
    sink = null;
  }
});

function signIn(key: SeededApiKey): void {
  ctx.session = { id: key.row.id, name: key.row.name, isAdmin: key.row.isAdmin };
}

function form(destinations: Array<{ channel: string; target: string }>): FormData {
  const fd = new FormData();
  destinations.forEach((d, i) => {
    fd.set(`destinations[${i}][channel]`, d.channel);
    fd.set(`destinations[${i}][target]`, d.target);
  });
  return fd;
}

function audited(type: string): Promise<AuditEvent[]> {
  return db.select().from(auditEvents).where(eq(auditEvents.eventType, type));
}

function secretOf(result: Awaited<ReturnType<typeof revealGlobalSigningSecretAction>>): string {
  if ("error" in result) throw new Error(`expected a secret, got error: ${result.error}`);
  return result.signing_secret;
}

function verifies(req: SinkRequest, secret: string): boolean {
  const expected =
    "sha256=" +
    createHmac("sha256", secret)
      .update(`${req.headers["x-mantis-timestamp"]}.${req.body}`)
      .digest("hex");
  return req.headers["x-mantis-signature"] === expected;
}

/** Saves one global webhook (pointing at the sink) as an admin; returns its row. */
async function saveGlobalWebhook(admin: SeededApiKey) {
  sink = await startSink({ status: 200 });
  signIn(admin);
  const state = await saveGlobalDestinationsAction({}, form([{ channel: "webhook", target: sink.url }]));
  expect(state.ok).toBe(true);
  const [row] = await listGlobalDestinations();
  return row!;
}

/** Fires a hit on a key with NO destinations of its own and delivers it. */
async function deliverHitOnBareKey(): Promise<SinkRequest> {
  const owner = await seedApiKey();
  const key = await seedCanaryKey(owner.row.id);
  const [hit] = await db.insert(hits).values({ keyId: key.id, ip: "203.0.113.7" }).returning();
  await enqueueNotifications(key, hit!);
  const before = sink!.requests.length;
  expect(await processBatch(10)).toBe(1);
  expect(sink!.requests).toHaveLength(before + 1);
  return sink!.requests.at(-1)!;
}

describe("global webhook signing secret: admin reveal", () => {
  it("returns the secret that actually signs a bare key's deliveries, and audits the reveal", async () => {
    const admin = await seedApiKey({ admin: true, name: "root admin" });
    const dest = await saveGlobalWebhook(admin);
    ctx.headers = { "x-forwarded-for": "198.51.100.9" };

    const result = await revealGlobalSigningSecretAction(dest.id);
    const secret = secretOf(result);
    expect(result).toMatchObject({ signing_secret_fingerprint: fingerprintSecret(secret) });

    const delivery = await deliverHitOnBareKey();
    expect(JSON.parse(delivery.body).type).toBe("mantis.hit");
    expect(verifies(delivery, secret)).toBe(true);

    const rows = await audited("destination.secret_revealed");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorApiKeyId: admin.row.id,
      actorLabel: "root admin",
      subjectKind: "destination",
      subjectId: dest.id,
      metadata: { scope: "global", channel: "webhook" },
    });
    expect(JSON.stringify(rows[0])).not.toContain(secret);
  });

  it("opens the at-rest envelope when MANTIS_SECRET_KEY seals the column", async () => {
    process.env.MANTIS_SECRET_KEY = "11".repeat(32);
    const admin = await seedApiKey({ admin: true });
    const dest = await saveGlobalWebhook(admin);
    expect(dest.signingSecret!.startsWith("encv1:")).toBe(true);

    const secret = secretOf(await revealGlobalSigningSecretAction(dest.id));
    expect(secret.startsWith("encv1:")).toBe(false);
    expect(verifies(await deliverHitOnBareKey(), secret)).toBe(true);
  });

  it("refuses a non-admin session and audits nothing", async () => {
    const admin = await seedApiKey({ admin: true });
    const dest = await saveGlobalWebhook(admin);

    signIn(await seedApiKey({ name: "key owner" }));
    expect(await revealGlobalSigningSecretAction(dest.id)).toEqual({ error: "admin only" });
    expect(await rotateGlobalSigningSecretAction(dest.id)).toEqual({ error: "admin only" });

    expect(await audited("destination.secret_revealed")).toHaveLength(0);
    expect(await audited("destinations.replaced")).toHaveLength(0);
    const [unchanged] = await listGlobalDestinations();
    expect(unchanged!.signingSecret).toBe(dest.signingSecret);
  });

  it("redirects to /login without a session", async () => {
    const admin = await seedApiKey({ admin: true });
    const dest = await saveGlobalWebhook(admin);
    ctx.session = null;
    await expect(revealGlobalSigningSecretAction(dest.id)).rejects.toThrow("NEXT_REDIRECT:/login");
    await expect(rotateGlobalSigningSecretAction(dest.id)).rejects.toThrow("NEXT_REDIRECT:/login");
  });

  it("only ever answers for a GLOBAL webhook row", async () => {
    const admin = await seedApiKey({ admin: true });
    signIn(admin);
    const key = await seedCanaryKey(admin.row.id);
    const [perKey] = await db
      .insert(notificationDestinations)
      .values({ keyId: key.id, channel: "webhook", target: "https://own.example/hook", signingSecret: "per-key-secret-0123456789" })
      .returning();
    const [globalEmail] = await db
      .insert(notificationDestinations)
      .values({ keyId: null, channel: "email", target: "ops@example.test" })
      .returning();

    for (const id of [perKey!.id, globalEmail!.id, "00000000-0000-4000-8000-000000000000", "not-a-uuid", ""]) {
      expect(await revealGlobalSigningSecretAction(id)).toEqual({ error: "not_found" });
      expect(await rotateGlobalSigningSecretAction(id)).toEqual({ error: "not_found" });
    }
    const [untouched] = await db
      .select()
      .from(notificationDestinations)
      .where(eq(notificationDestinations.id, perKey!.id));
    expect(untouched!.signingSecret).toBe("per-key-secret-0123456789");
    expect(await audited("destination.secret_revealed")).toHaveLength(0);
  });
});

describe("global webhook signing secret: admin rotate", () => {
  it("issues a new secret that signs later deliveries, and audits the rotation", async () => {
    const admin = await seedApiKey({ admin: true, name: "root admin" });
    const dest = await saveGlobalWebhook(admin);
    const before = secretOf(await revealGlobalSigningSecretAction(dest.id));

    const rotated = await rotateGlobalSigningSecretAction(dest.id);
    const after = secretOf(rotated);
    expect(after).not.toBe(before);
    expect(rotated).toMatchObject({ signing_secret_fingerprint: fingerprintSecret(after) });
    expect(secretOf(await revealGlobalSigningSecretAction(dest.id))).toBe(after);

    const delivery = await deliverHitOnBareKey();
    expect(verifies(delivery, after)).toBe(true);
    expect(verifies(delivery, before)).toBe(false);

    const rows = await audited("destinations.replaced");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorApiKeyId: admin.row.id,
      subjectKind: "destination",
      subjectId: dest.id,
      metadata: { scope: "global", action: "rotate_signing_secret" },
    });
    expect(JSON.stringify(rows[0])).not.toContain(after);
  });
});

describe("replacing the global destination set is audited", () => {
  const HA = "http://127.0.0.1:9/api/webhook/super-secret-ha-webhook-id";

  it("writes one global_destinations.replaced row per save, with counts and channels only", async () => {
    const admin = await seedApiKey({ admin: true, name: "root admin" });
    sink = await startSink({ status: 200 });
    signIn(admin);
    ctx.headers = { "x-forwarded-for": "198.51.100.9" };

    const saved = await saveGlobalDestinationsAction(
      {},
      form([
        { channel: "webhook", target: sink.url },
        { channel: "home_assistant", target: HA },
      ]),
    );
    expect(saved.ok).toBe(true);

    let rows = await audited("global_destinations.replaced");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorApiKeyId: admin.row.id,
      actorLabel: "root admin",
      subjectKind: "global_destinations",
      metadata: {
        count: 2,
        channels: ["webhook", "home_assistant"],
        added: 2,
        removed: 0,
        via: "dashboard",
      },
    });
    // Targets are credentials: the audit log must not become a copy of them.
    expect(JSON.stringify(rows)).not.toContain("super-secret-ha-webhook-id");
    expect(JSON.stringify(rows)).not.toContain(sink.url);

    // Wiping every global destination — silencing bulk-minted keys — is the
    // change an intruder with an admin session would make. It is recorded.
    expect((await saveGlobalDestinationsAction({}, form([]))).ok).toBe(true);
    rows = await audited("global_destinations.replaced");
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.metadata)).toContainEqual({
      count: 0,
      channels: [],
      added: 0,
      removed: 2,
      via: "dashboard",
    });
    expect(await listGlobalDestinations()).toEqual([]);
  });

  it("writes nothing for a refused save", async () => {
    const admin = await seedApiKey({ admin: true });
    signIn(await seedApiKey());
    expect(
      await saveGlobalDestinationsAction({}, form([{ channel: "home_assistant", target: HA }])),
    ).toEqual({ error: "admin only" });

    signIn(admin);
    const invalid = await saveGlobalDestinationsAction(
      {},
      form([{ channel: "slack", target: "https://example.com/not-slack" }]),
    );
    expect(invalid.error).toMatch(/destination 1/);

    expect(await audited("global_destinations.replaced")).toHaveLength(0);
    expect(await listGlobalDestinations()).toEqual([]);
  });

  it("refuses a global webhook that points back at this instance", async () => {
    signIn(await seedApiKey({ admin: true }));
    const state = await saveGlobalDestinationsAction(
      {},
      form([{ channel: "webhook", target: "http://localhost:3000/c/AbCdEf1234" }]),
    );
    expect(state.error).toMatch(/must not point at this Mantis instance/);
    expect(await listGlobalDestinations()).toEqual([]);
  });
});
