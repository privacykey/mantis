import { describe, it, expect, vi } from "vitest";

// E2E-22 — A pre-pepper v1 (SHA-256) API key still authenticates and is
// opportunistically migrated to the v2 (HMAC) hash in the DB on first use
// (resolveByPlaintext in src/lib/auth.ts), without orphaning the row.

vi.mock("@/lib/log", () => ({
  log: { info() {}, warn() {}, error() {}, debug() {}, fatal() {}, trace() {} },
}));

import { GET as listApiKeys } from "@/app/api/api-keys/route";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { apiKeys } from "@/db/schema";
import { mintApiKey, hashApiKey, legacySha256ApiKey } from "@/lib/api-keys";
import { buildJsonRequest, waitFor } from "./_harness";

describe("E2E-22 legacy v1 key migrates to v2 on use", () => {
  it("authenticates a v1-hashed row and rewrites the stored hash to v2", async () => {
    const { plaintext } = mintApiKey();
    const v1 = legacySha256ApiKey(plaintext);
    const v2 = hashApiKey(plaintext);
    expect(v1).not.toBe(v2);

    const [row] = await db
      .insert(apiKeys)
      .values({ name: "legacy", prefix: plaintext.slice(0, 18), hash: v1 })
      .returning();

    // First use: authenticates against the v1 hash.
    const res = await listApiKeys(
      buildJsonRequest("/api/api-keys", { bearer: plaintext }),
    );
    expect(res.status).toBe(200);

    // The stored hash is opportunistically upgraded to v2 (fire-and-forget).
    const upgraded = await waitFor(async () => {
      const [r] = await db.select().from(apiKeys).where(eq(apiKeys.id, row!.id)).limit(1);
      return r?.hash === v2;
    });
    expect(upgraded).toBe(true);

    // Still resolvable by the same plaintext afterward (now via v2).
    const again = await listApiKeys(
      buildJsonRequest("/api/api-keys", { bearer: plaintext }),
    );
    expect(again.status).toBe(200);
  });
});
