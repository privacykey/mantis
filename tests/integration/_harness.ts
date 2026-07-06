import { afterEach } from "vitest";
import { NextRequest } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/db/client";
import { apiKeys, keys, type ApiKey, type Key } from "@/db/schema";
import { mintApiKey } from "@/lib/api-keys";

// Every table the integration tests touch. Order doesn't matter — CASCADE
// handles FK children — but listing them all keeps each test isolated.
const TABLES = [
  "hits",
  "notifications",
  "notification_destinations",
  "wallet_registrations",
  "wallet_config",
  "sessions",
  "audit_events",
  "rate_limits",
  "keys",
  "api_keys",
] as const;

export async function truncateAll(): Promise<void> {
  await db.execute(
    sql.raw(
      `TRUNCATE ${TABLES.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`,
    ),
  );
}

// Importing the harness wipes the DB after every test in the importing file, so
// tests never see each other's rows.
afterEach(truncateAll);

export type SeededApiKey = { plaintext: string; row: ApiKey };

/**
 * Inserts a real API key row (HMAC-hashed under the test pepper) and returns
 * the plaintext so tests can present it as a Bearer token. Uses the production
 * mintApiKey() so the stored hash matches what requireApiKey() recomputes.
 */
export async function seedApiKey(
  opts: { admin?: boolean; name?: string; scope?: "full" | "enroll" } = {},
): Promise<SeededApiKey> {
  const minted = mintApiKey();
  const [row] = await db
    .insert(apiKeys)
    .values({
      name: opts.name ?? (opts.admin ? "admin" : "user"),
      prefix: minted.prefix,
      hash: minted.hash,
      isAdmin: opts.admin ?? false,
      scope: opts.scope ?? "full",
    })
    .returning();
  if (!row) throw new Error("seedApiKey: insert returned no row");
  return { plaintext: minted.plaintext, row };
}

/** Inserts a canary key directly (bypasses the API) for trigger/wallet tests. */
export async function seedCanaryKey(
  ownerId: string | null,
  overrides: Partial<typeof keys.$inferInsert> = {},
): Promise<Key> {
  const [row] = await db
    .insert(keys)
    .values({
      publicId: overrides.publicId ?? randomPublicId(),
      memo: overrides.memo ?? "integration canary",
      responseKind: overrides.responseKind ?? "gif",
      responsePayload: overrides.responsePayload ?? null,
      dedupeWindowSeconds: overrides.dedupeWindowSeconds ?? 60,
      createdByApiKeyId: ownerId,
      ...overrides,
    })
    .returning();
  if (!row) throw new Error("seedCanaryKey: insert returned no row");
  return row;
}

let pidCounter = 0;
/** Deterministic, collision-free public id (matches the SAFE_ID_RE on /c). */
export function randomPublicId(): string {
  pidCounter += 1;
  return `it${String(pidCounter).padStart(8, "0")}`;
}

export function buildJsonRequest(
  url: string,
  init: {
    method?: string;
    bearer?: string;
    body?: unknown;
    headers?: Record<string, string>;
  } = {},
): NextRequest {
  const headers = new Headers(init.headers);
  if (init.bearer) headers.set("authorization", `Bearer ${init.bearer}`);
  if (init.body !== undefined) headers.set("content-type", "application/json");
  return new NextRequest(new URL(url, "http://localhost:3000"), {
    method: init.method ?? "GET",
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
}

/** App Router passes ctx.params as a Promise in Next 16. */
export function ctxParams<T extends Record<string, string>>(
  params: T,
): { params: Promise<T> } {
  return { params: Promise.resolve(params) };
}

/**
 * Polls a predicate until it returns true or the deadline passes. Used to
 * assert on fire-and-forget writes (e.g. lastUsedAt) the handler doesn't await.
 */
export async function waitFor(
  predicate: () => Promise<boolean> | boolean,
  { timeoutMs = 3000, intervalMs = 25 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** Shared @/lib/log mock body — avoids spinning up the pino-pretty worker. */
export const logMock = {
  log: {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    fatal: () => {},
    trace: () => {},
    child: () => logMock.log,
  },
};
