import { describe, it, expect, vi } from "vitest";

// E2E-18 — API-key management privilege boundaries: only an admin can mint an
// admin key or revoke another key; non-admins are scoped to their own row;
// 403 vs 404 information hygiene; idempotent re-revoke.

vi.mock("@/lib/log", () => ({
  log: { info() {}, warn() {}, error() {}, debug() {}, fatal() {}, trace() {} },
}));

import { POST as createApiKey, GET as listApiKeys } from "@/app/api/api-keys/route";
import { DELETE as revokeApiKey } from "@/app/api/api-keys/[id]/route";
import { db } from "@/db/client";
import { apiKeys } from "@/db/schema";
import { eq } from "drizzle-orm";
import { seedApiKey, buildJsonRequest, ctxParams } from "./_harness";

async function countKeys(): Promise<number> {
  return (await db.select().from(apiKeys)).length;
}

describe("E2E-18 API key management authz", () => {
  it("a non-admin cannot mint an admin key; an admin can", async () => {
    const admin = await seedApiKey({ admin: true });
    const user = await seedApiKey();

    const before = await countKeys();
    const denied = await createApiKey(
      buildJsonRequest("/api/api-keys", {
        method: "POST",
        bearer: user.plaintext,
        body: { name: "escalation", is_admin: true },
      }),
    );
    expect(denied.status).toBe(403);
    expect(await countKeys()).toBe(before); // no row inserted

    const ok = await createApiKey(
      buildJsonRequest("/api/api-keys", {
        method: "POST",
        bearer: admin.plaintext,
        body: { name: "second-admin", is_admin: true },
      }),
    );
    expect(ok.status).toBe(201);
    const body = await ok.text();
    expect(body).not.toMatch(/"hash"/); // plaintext returned once, hash never
  });

  it("scopes the list: non-admin sees only itself, admin sees all", async () => {
    const admin = await seedApiKey({ admin: true });
    const a = await seedApiKey();
    const b = await seedApiKey();

    const userList = (await (
      await listApiKeys(buildJsonRequest("/api/api-keys", { bearer: a.plaintext }))
    ).json()) as { data: { id: string }[] };
    expect(userList.data.map((k) => k.id)).toEqual([a.row.id]);

    const adminList = (await (
      await listApiKeys(buildJsonRequest("/api/api-keys", { bearer: admin.plaintext }))
    ).json()) as { data: { id: string }[] };
    const ids = adminList.data.map((k) => k.id);
    expect(ids).toEqual(expect.arrayContaining([admin.row.id, a.row.id, b.row.id]));
  });

  it("a non-admin cannot revoke another key (403, target untouched)", async () => {
    const a = await seedApiKey();
    const b = await seedApiKey();

    const res = await revokeApiKey(
      buildJsonRequest(`/api/api-keys/${b.row.id}`, {
        method: "DELETE",
        bearer: a.plaintext,
      }),
      ctxParams({ id: b.row.id }),
    );
    expect(res.status).toBe(403);

    const [bRow] = await db.select().from(apiKeys).where(eq(apiKeys.id, b.row.id)).limit(1);
    expect(bRow!.revokedAt).toBeNull();
  });

  it("admin revoke is idempotent; malformed/unknown ids are 404", async () => {
    const admin = await seedApiKey({ admin: true });
    const b = await seedApiKey();

    const first = await revokeApiKey(
      buildJsonRequest(`/api/api-keys/${b.row.id}`, { method: "DELETE", bearer: admin.plaintext }),
      ctxParams({ id: b.row.id }),
    );
    expect(first.status).toBe(204);

    const again = await revokeApiKey(
      buildJsonRequest(`/api/api-keys/${b.row.id}`, { method: "DELETE", bearer: admin.plaintext }),
      ctxParams({ id: b.row.id }),
    );
    expect(again.status).toBe(404); // already revoked

    const malformed = await revokeApiKey(
      buildJsonRequest("/api/api-keys/not-a-uuid", { method: "DELETE", bearer: admin.plaintext }),
      ctxParams({ id: "not-a-uuid" }),
    );
    expect(malformed.status).toBe(404);

    const unknown = "00000000-0000-0000-0000-0000000000ff";
    const missing = await revokeApiKey(
      buildJsonRequest(`/api/api-keys/${unknown}`, { method: "DELETE", bearer: admin.plaintext }),
      ctxParams({ id: unknown }),
    );
    expect(missing.status).toBe(404);
  });
});
