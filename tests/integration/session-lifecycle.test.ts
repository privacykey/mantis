import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHash } from "node:crypto";

// E2E-08 — Dashboard session lifecycle against real Postgres: mint → resolve →
// revoke → reuse-rejected, plus expired-session and revoked-api-key rows fail
// to resolve. Exercises the real join predicates (expiresAt > now(),
// sessions.revokedAt IS NULL, apiKeys.revokedAt IS NULL) that mocks paper over,
// and proves the cookie plaintext is never stored (only its SHA-256).

const store = vi.hoisted(() => ({
  cookies: new Map<string, string>(),
  headers: new Map<string, string>([["user-agent", "it-session"]]),
}));

vi.mock("@/lib/log", () => ({
  log: { info() {}, warn() {}, error() {}, debug() {}, fatal() {}, trace() {} },
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (n: string) =>
      store.cookies.has(n) ? { name: n, value: store.cookies.get(n) } : undefined,
    set: (o: { name: string; value: string }) => {
      store.cookies.set(o.name, o.value);
    },
    delete: (n: string) => {
      store.cookies.delete(n);
    },
  }),
  headers: async () => ({
    get: (n: string) => store.headers.get(n.toLowerCase()) ?? null,
  }),
}));

import {
  setSessionCookie,
  getSessionApiKey,
  clearSessionCookie,
} from "@/lib/session";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { apiKeys, sessions } from "@/db/schema";
import { seedApiKey } from "./_harness";

const COOKIE = "mantis_session";

beforeEach(() => {
  store.cookies.clear();
});

describe("E2E-08 session lifecycle", () => {
  it("mints, resolves, then revokes a session; the cookie plaintext is never stored", async () => {
    const op = await seedApiKey();

    const token = await setSessionCookie(op.row.id);
    expect(store.cookies.get(COOKIE)).toBe(token);

    // Resolves to the owning API key.
    const resolved = await getSessionApiKey();
    expect(resolved?.id).toBe(op.row.id);

    // Stored as SHA-256, not plaintext.
    const [row] = await db
      .select()
      .from(sessions)
      .where(eq(sessions.apiKeyId, op.row.id))
      .limit(1);
    expect(row!.tokenHash).toBe(createHash("sha256").update(token).digest("hex"));
    expect(row!.tokenHash).not.toBe(token);

    // Logout revokes the row and clears the cookie; reuse no longer resolves.
    await clearSessionCookie();
    expect(store.cookies.has(COOKIE)).toBe(false);
    const [revoked] = await db
      .select()
      .from(sessions)
      .where(eq(sessions.id, row!.id))
      .limit(1);
    expect(revoked!.revokedAt).not.toBeNull();
    expect(await getSessionApiKey()).toBeNull();
  });

  it("an expired session does not resolve", async () => {
    const op = await seedApiKey();
    const token = `mantis_sess_${"e".repeat(40)}`;
    await db.insert(sessions).values({
      tokenHash: createHash("sha256").update(token).digest("hex"),
      tokenPrefix: token.slice(0, 18),
      apiKeyId: op.row.id,
      expiresAt: new Date(Date.now() - 60_000),
    });
    store.cookies.set(COOKIE, token);

    expect(await getSessionApiKey()).toBeNull();
  });

  it("a session whose API key was revoked does not resolve", async () => {
    const op = await seedApiKey();
    await setSessionCookie(op.row.id);

    await db
      .update(apiKeys)
      .set({ revokedAt: new Date() })
      .where(eq(apiKeys.id, op.row.id));

    expect(await getSessionApiKey()).toBeNull();
  });
});
