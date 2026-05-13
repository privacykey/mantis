import { eq, isNull, and, sql } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { db } from "@/db/client";
import { apiKeys, keys, type ApiKey, type Key } from "@/db/schema";
import { hashApiKey, isWellFormedApiKey } from "@/lib/api-keys";

export type AuthResult = { ok: true; key: ApiKey } | { ok: false; res: NextResponse };

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Admin → all; non-admin → only rows they created. */
export function canAccessKey(
  authedKey: ApiKey,
  row: { createdByApiKeyId: string | null } | null | undefined,
): boolean {
  if (!row) return false;
  if (authedKey.isAdmin) return true;
  return row.createdByApiKeyId === authedKey.id;
}

/** Loads a mantis key by id, gated by canAccessKey. Returns null for missing or unowned. */
export async function loadOwnedKey(
  authed: ApiKey,
  id: string,
): Promise<Key | null> {
  if (!UUID_RE.test(id)) return null;
  const [row] = await db.select().from(keys).where(eq(keys.id, id)).limit(1);
  if (!canAccessKey(authed, row)) return null;
  return row ?? null;
}

function unauthorized(message: string): NextResponse {
  return NextResponse.json(
    { error: "unauthorized", message },
    {
      status: 401,
      headers: { "WWW-Authenticate": 'Bearer realm="mantis"' },
    },
  );
}

function extractBearer(req: NextRequest): string | null {
  const header = req.headers.get("authorization");
  if (!header) return null;
  const [scheme, value] = header.split(/\s+/, 2);
  if (!scheme || scheme.toLowerCase() !== "bearer" || !value) return null;
  return value;
}

async function resolveByPlaintext(presented: string): Promise<ApiKey | null> {
  if (!isWellFormedApiKey(presented)) return null;
  const hash = hashApiKey(presented);
  const rows = await db
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.hash, hash), isNull(apiKeys.revokedAt)))
    .limit(1);
  const key = rows[0] ?? null;
  if (key) {
    void db
      .update(apiKeys)
      .set({ lastUsedAt: sql`now()` })
      .where(eq(apiKeys.id, key.id))
      .catch(() => {});
  }
  return key;
}

export async function requireApiKey(req: NextRequest): Promise<AuthResult> {
  const presented = extractBearer(req);
  if (!presented) {
    return { ok: false, res: unauthorized("missing Authorization: Bearer token") };
  }
  if (!isWellFormedApiKey(presented)) {
    return { ok: false, res: unauthorized("malformed API key") };
  }
  const key = await resolveByPlaintext(presented);
  if (!key) {
    return { ok: false, res: unauthorized("invalid or revoked API key") };
  }
  return { ok: true, key };
}

// Allow either Bearer token (CLI/API) or the session cookie (dashboard browser).
export async function requireApiKeyOrSession(
  req: NextRequest,
): Promise<AuthResult> {
  const bearer = extractBearer(req);
  if (bearer) {
    const key = await resolveByPlaintext(bearer);
    if (key) return { ok: true, key };
    return { ok: false, res: unauthorized("invalid or revoked API key") };
  }
  const { getSessionApiKey } = await import("@/lib/session");
  const session = await getSessionApiKey();
  if (session) return { ok: true, key: session };
  return { ok: false, res: unauthorized("missing Authorization or session") };
}
