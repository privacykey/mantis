import { describe, it, expect, vi, afterEach } from "vitest";

// E2E-07 — API bearer auth boundary against real Postgres (the requireApiKey
// path that unit tests never exercise): valid key works + stamps lastUsedAt and
// never leaks its hash, a revoked key is rejected, and 60 failures/IP trips a
// 429 while a valid key bypasses the limiter entirely.

vi.mock("@/lib/log", () => ({
  log: { info() {}, warn() {}, error() {}, debug() {}, fatal() {}, trace() {} },
}));

import { GET as listApiKeys } from "@/app/api/api-keys/route";
import { DELETE as deleteApiKey } from "@/app/api/api-keys/[id]/route";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { apiKeys } from "@/db/schema";
import { seedApiKey, buildJsonRequest, ctxParams, waitFor } from "./_harness";

const BAD_KEY = `mantis_live_${"z".repeat(40)}`;

afterEach(() => {
  delete process.env.TRUST_PROXY_HEADERS;
});

describe("E2E-07 API key auth boundary", () => {
  it("valid key authenticates, stamps lastUsedAt, and never leaks its hash", async () => {
    const admin = await seedApiKey({ admin: true });

    const res = await listApiKeys(
      buildJsonRequest("/api/api-keys", { bearer: admin.plaintext }),
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toMatch(/"hash"/);
    const body = JSON.parse(text) as { data: { id: string }[] };
    expect(body.data.map((k) => k.id)).toContain(admin.row.id);

    // lastUsedAt is a fire-and-forget update — poll for it.
    const stamped = await waitFor(async () => {
      const [row] = await db
        .select()
        .from(apiKeys)
        .where(eq(apiKeys.id, admin.row.id))
        .limit(1);
      return row?.lastUsedAt != null;
    });
    expect(stamped).toBe(true);
  });

  it("a revoked key is rejected with 401", async () => {
    const admin = await seedApiKey({ admin: true });

    const del = await deleteApiKey(
      buildJsonRequest(`/api/api-keys/${admin.row.id}`, {
        method: "DELETE",
        bearer: admin.plaintext,
      }),
      ctxParams({ id: admin.row.id }),
    );
    expect(del.status).toBe(204);

    const after = await listApiKeys(
      buildJsonRequest("/api/api-keys", { bearer: admin.plaintext }),
    );
    expect(after.status).toBe(401);
    expect(after.headers.get("www-authenticate")).toContain("Bearer");
  });

  it("60 failures per IP trip a 429, but a valid key bypasses the limiter", async () => {
    process.env.TRUST_PROXY_HEADERS = "1";
    const ip = "198.51.100.7";
    const headers = { "cf-connecting-ip": ip };

    // 60 failures are 401; the 61st is throttled.
    for (let i = 0; i < 60; i++) {
      const res = await listApiKeys(
        buildJsonRequest("/api/api-keys", { bearer: BAD_KEY, headers }),
      );
      expect(res.status).toBe(401);
    }
    const throttled = await listApiKeys(
      buildJsonRequest("/api/api-keys", { bearer: BAD_KEY, headers }),
    );
    expect(throttled.status).toBe(429);
    expect(throttled.headers.get("retry-after")).toBeTruthy();

    // A VALID key from the same IP still works — successful auth never touches
    // the failure limiter.
    const good = await seedApiKey();
    const ok = await listApiKeys(
      buildJsonRequest("/api/api-keys", { bearer: good.plaintext, headers }),
    );
    expect(ok.status).toBe(200);
  });
});
