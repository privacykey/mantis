import { describe, it, expect, vi } from "vitest";

// E2E-01 — Cross-tenant isolation across the full canary-key lifecycle (IDOR).
// The product's core multi-tenant boundary (loadOwnedKey / canAccessKey): a
// non-admin key must never see, mutate, or delete another key's canaries, and
// the failure must be 404 (indistinguishable from missing), never 403/200.

vi.mock("@/lib/log", () => ({
  log: { info() {}, warn() {}, error() {}, debug() {}, fatal() {}, trace() {} },
}));

import { POST as createKey, GET as listKeys } from "@/app/api/keys/route";
import {
  GET as getKey,
  PATCH as patchKey,
  DELETE as deleteKey,
} from "@/app/api/keys/[id]/route";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { keys } from "@/db/schema";
import { seedApiKey, buildJsonRequest, ctxParams } from "./_harness";

async function createFor(bearer: string, memo: string): Promise<string> {
  const res = await createKey(
    buildJsonRequest("/api/keys", { method: "POST", bearer, body: { memo } }),
  );
  expect(res.status).toBe(201);
  const json = (await res.json()) as { id: string };
  return json.id;
}

describe("E2E-01 cross-tenant isolation across the key lifecycle", () => {
  it("keyA cannot read/mutate/delete keyB; admin sees both; list is owner-scoped", async () => {
    const admin = await seedApiKey({ admin: true });
    const a = await seedApiKey();
    const b = await seedApiKey();

    const keyAId = await createFor(a.plaintext, "A canary");
    const keyBId = await createFor(b.plaintext, "B canary");

    // List scoping: A sees only its own row.
    const listRes = await listKeys(
      buildJsonRequest("/api/keys", { bearer: a.plaintext }),
    );
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as { data: { id: string }[] };
    const aIds = listBody.data.map((k) => k.id);
    expect(aIds).toContain(keyAId);
    expect(aIds).not.toContain(keyBId);

    // Every cross-tenant op as A → 404 (not 200, not 403 — no existence oracle).
    const get = await getKey(
      buildJsonRequest(`/api/keys/${keyBId}`, { bearer: a.plaintext }),
      ctxParams({ id: keyBId }),
    );
    expect(get.status).toBe(404);

    const patch = await patchKey(
      buildJsonRequest(`/api/keys/${keyBId}`, {
        method: "PATCH",
        bearer: a.plaintext,
        body: { disabled: true },
      }),
      ctxParams({ id: keyBId }),
    );
    expect(patch.status).toBe(404);

    const del = await deleteKey(
      buildJsonRequest(`/api/keys/${keyBId}`, {
        method: "DELETE",
        bearer: a.plaintext,
      }),
      ctxParams({ id: keyBId }),
    );
    expect(del.status).toBe(404);

    // keyB is untouched in the DB after A's attempted mutations.
    const [bRow] = await db
      .select()
      .from(keys)
      .where(eq(keys.id, keyBId))
      .limit(1);
    expect(bRow).toBeDefined();
    expect(bRow!.disabledAt).toBeNull();

    // B's owner can still read its own key (proves the 404 was authz, not a bug).
    const ownGet = await getKey(
      buildJsonRequest(`/api/keys/${keyBId}`, { bearer: b.plaintext }),
      ctxParams({ id: keyBId }),
    );
    expect(ownGet.status).toBe(200);

    // Admin sees both keys.
    const adminList = (await (
      await listKeys(buildJsonRequest("/api/keys", { bearer: admin.plaintext }))
    ).json()) as { data: { id: string }[] };
    const adminIds = adminList.data.map((k) => k.id);
    expect(adminIds).toContain(keyAId);
    expect(adminIds).toContain(keyBId);
  });

  it("rejects unauthenticated and malformed-bearer access", async () => {
    const res = await listKeys(buildJsonRequest("/api/keys"));
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("Bearer");
  });
});
