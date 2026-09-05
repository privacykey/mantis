import { eq, isNull, and, inArray, sql } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { db } from "@/db/client";
import { apiKeys, keys, type ApiKey, type Key } from "@/db/schema";
import {
  hashApiKey,
  isWellFormedApiKey,
  legacySha256ApiKey,
} from "@/lib/api-keys";
import {
  consumeRateLimit,
  rateLimitHeaders,
  type RateLimitResult,
} from "@/lib/rate-limit";
import { extractIp } from "@/lib/request-info";

export type AuthResult = { ok: true; key: ApiKey } | { ok: false; res: NextResponse };

// Throttle repeated API-key auth FAILURES per IP. Successful auths never touch
// the limiter, so legitimate traffic is unaffected. Keys are 192-bit (online
// brute force is already infeasible) — this is hygiene + a cluster-wide
// speed-bump that the old in-memory limiter couldn't provide.
const AUTH_FAIL_LIMIT = 60;
const AUTH_FAIL_WINDOW_MS = 60_000;

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

function forbiddenScope(): NextResponse {
  return NextResponse.json(
    {
      error: "forbidden",
      message:
        "this API key is enrollment-scoped; it can only create keys via POST /api/keys",
    },
    { status: 403 },
  );
}

function tooManyRequests(rl: RateLimitResult): NextResponse {
  return NextResponse.json(
    { error: "rate_limited", message: "too many authentication attempts" },
    { status: 429, headers: rateLimitHeaders(rl) },
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
  // Look up by either the v2 (HMAC, current) or v1 (SHA-256, legacy) hash.
  // Both are 64-char hex; the column is indexed, so this is still O(1).
  // Once we've verified the row, opportunistically migrate v1 → v2 so the
  // legacy column drains over time.
  const v2 = hashApiKey(presented);
  const v1 = legacySha256ApiKey(presented);
  const rows = await db
    .select()
    .from(apiKeys)
    .where(and(inArray(apiKeys.hash, [v2, v1]), isNull(apiKeys.revokedAt)))
    .limit(1);
  const key = rows[0] ?? null;
  if (key) {
    const needsUpgrade = key.hash !== v2;
    void db
      .update(apiKeys)
      .set({
        lastUsedAt: sql`now()`,
        ...(needsUpgrade ? { hash: v2 } : {}),
      })
      .where(eq(apiKeys.id, key.id))
      .catch(() => {});
  }
  return key;
}

export type RequireApiKeyOpts = {
  /**
   * Accept enrollment-scoped keys. Default false — every route is full-scope
   * only unless it explicitly opts in, so a new route can't accidentally
   * widen what a fleet-embedded enroll key can reach. Only POST /api/keys
   * (key creation) sets this.
   */
  allowEnroll?: boolean;
};

/**
 * Every bearer failure consumes a per-IP token; once the window is exhausted
 * we return 429 instead of 401 to blunt brute force. Valid keys skip this
 * entirely, so the DB is only touched on failed attempts. Shared by both
 * auth entrypoints so a route can't become a limiter-free guessing oracle.
 */
async function failBearer(
  req: NextRequest,
  message: string,
): Promise<AuthResult> {
  const ip = extractIp(req) ?? "unknown";
  const rl = await consumeRateLimit(`auth-fail:${ip}`, {
    limit: AUTH_FAIL_LIMIT,
    windowMs: AUTH_FAIL_WINDOW_MS,
  });
  if (!rl.ok) return { ok: false, res: tooManyRequests(rl) };
  return { ok: false, res: unauthorized(message) };
}

export async function requireApiKey(
  req: NextRequest,
  opts: RequireApiKeyOpts = {},
): Promise<AuthResult> {
  const presented = extractBearer(req);
  const fail = (message: string) => failBearer(req, message);

  if (!presented) return fail("missing Authorization: Bearer token");
  if (!isWellFormedApiKey(presented)) return fail("malformed API key");
  const key = await resolveByPlaintext(presented);
  if (!key) return fail("invalid or revoked API key");
  // Valid credential, insufficient scope — 403 without consuming the
  // brute-force limiter (this isn't a guessing attempt).
  if (key.scope === "enroll" && !opts.allowEnroll) {
    return { ok: false, res: forbiddenScope() };
  }
  return { ok: true, key };
}

// Allow either Bearer token (CLI/API) or the session cookie (dashboard browser).
// Always full-scope: everything session-reachable is dashboard surface, which
// enrollment-scoped keys must not touch (login rejects them too).
export async function requireApiKeyOrSession(
  req: NextRequest,
): Promise<AuthResult> {
  const bearer = extractBearer(req);
  if (bearer) {
    const key = await resolveByPlaintext(bearer);
    if (key?.scope === "enroll") return { ok: false, res: forbiddenScope() };
    if (key) return { ok: true, key };
    return failBearer(req, "invalid or revoked API key");
  }
  const { getSessionApiKey } = await import("@/lib/session");
  const session = await getSessionApiKey();
  if (session) return { ok: true, key: session };
  return { ok: false, res: unauthorized("missing Authorization or session") };
}
