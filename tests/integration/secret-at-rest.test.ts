import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";

// E2E-09 — Webhook signing-secret confidentiality (commit 2170e3a3). With
// MANTIS_SECRET_KEY set, a destination's HMAC secret is sealed (encv1:) at rest
// in Postgres, returned in plaintext exactly once on create, and never on read.

vi.mock("@/lib/log", () => ({
  log: { info() {}, warn() {}, error() {}, debug() {}, fatal() {}, trace() {} },
}));

import { POST as createKey } from "@/app/api/keys/route";
import { GET as getKey } from "@/app/api/keys/[id]/route";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { notificationDestinations } from "@/db/schema";
import { seedApiKey, buildJsonRequest, ctxParams } from "./_harness";

beforeAll(() => {
  // 32-byte key (64 hex chars) enables at-rest encryption.
  process.env.MANTIS_SECRET_KEY = "11".repeat(32);
});
afterAll(() => {
  delete process.env.MANTIS_SECRET_KEY;
});

type CreateBody = {
  id: string;
  destinations: { signing_secret: string | null }[];
};

describe("E2E-09 webhook secret sealed at rest, revealed only on create", () => {
  it("seals the signing secret in Postgres and hides it on reads", async () => {
    const op = await seedApiKey();

    // A loopback target passes shape validation; the SSRF preflight rejects it
    // fast so the activation ping fails without a real network call — but the
    // sealed destination row is still created.
    const createRes = await createKey(
      buildJsonRequest("/api/keys", {
        method: "POST",
        bearer: op.plaintext,
        body: {
          memo: "secret-at-rest",
          destinations: [{ channel: "webhook", target: "http://127.0.0.1:9/hook" }],
        },
      }),
    );
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as CreateBody;
    const plaintext = created.destinations[0]!.signing_secret;
    expect(typeof plaintext).toBe("string");
    expect(plaintext!.length).toBeGreaterThan(10);

    // At rest: encrypted envelope, plaintext nowhere in the column.
    const [row] = await db
      .select()
      .from(notificationDestinations)
      .where(eq(notificationDestinations.keyId, created.id))
      .limit(1);
    expect(row!.signingSecret).toBeTruthy();
    expect(row!.signingSecret!.startsWith("encv1:")).toBe(true);
    expect(row!.signingSecret).not.toContain(plaintext!);

    // On read: secret is withheld; only the fingerprint is exposed.
    const getRes = await getKey(
      buildJsonRequest(`/api/keys/${created.id}`, { bearer: op.plaintext }),
      ctxParams({ id: created.id }),
    );
    expect(getRes.status).toBe(200);
    const read = (await getRes.json()) as {
      destinations: {
        signing_secret: string | null;
        signing_secret_fingerprint: string | null;
      }[];
    };
    expect(read.destinations[0]!.signing_secret).toBeNull();
    const expectedFp = `${plaintext!.slice(0, 4)}…${plaintext!.slice(-4)}`;
    expect(read.destinations[0]!.signing_secret_fingerprint).toBe(expectedFp);
  });
});
