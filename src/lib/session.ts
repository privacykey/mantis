import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { cookies, headers } from "next/headers";
import { db } from "@/db/client";
import { apiKeys, sessions, type ApiKey } from "@/db/schema";
import { clientIpFromHeaders } from "@/lib/request-info";

const COOKIE_NAME = "mantis_session";
const SESSION_PREFIX = "mantis_sess_";
const MAX_AGE_SECONDS = 60 * 60 * 24 * 30; // 30 days

function hashToken(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex");
}

function isWellFormedSession(value: string): boolean {
  return value.startsWith(SESSION_PREFIX) && value.length > SESSION_PREFIX.length + 16;
}

function mintToken(): { plaintext: string; prefix: string; hash: string } {
  const body = randomBytes(32).toString("base64url");
  const plaintext = SESSION_PREFIX + body;
  return {
    plaintext,
    prefix: plaintext.slice(0, SESSION_PREFIX.length + 6),
    hash: hashToken(plaintext),
  };
}

/** Resolves the session cookie to its API key, or null if missing/revoked/expired. */
export async function getSessionApiKey(): Promise<ApiKey | null> {
  const jar = await cookies();
  const value = jar.get(COOKIE_NAME)?.value;
  if (!value || !isWellFormedSession(value)) return null;

  const tokenHash = hashToken(value);
  const [row] = await db
    .select({ key: apiKeys, sessionId: sessions.id })
    .from(sessions)
    .innerJoin(apiKeys, eq(apiKeys.id, sessions.apiKeyId))
    .where(
      and(
        eq(sessions.tokenHash, tokenHash),
        isNull(sessions.revokedAt),
        gt(sessions.expiresAt, sql`now()`),
        isNull(apiKeys.revokedAt),
      ),
    )
    .limit(1);
  if (!row) return null;

  // Fire-and-forget last-used touch.
  void db
    .update(sessions)
    .set({ lastUsedAt: sql`now()` })
    .where(eq(sessions.id, row.sessionId))
    .catch(() => {});

  return row.key;
}

/** Mints a session, writes the cookie, returns the plaintext token. */
export async function setSessionCookie(apiKeyId: string): Promise<string> {
  const minted = mintToken();
  const hdrs = await headers();
  const userAgent = hdrs.get("user-agent")?.slice(0, 500) ?? null;
  const ip = readClientIp(hdrs);

  const expiresAt = new Date(Date.now() + MAX_AGE_SECONDS * 1000);
  await db.insert(sessions).values({
    tokenHash: minted.hash,
    tokenPrefix: minted.prefix,
    apiKeyId,
    expiresAt,
    userAgent,
    ip,
  });

  const jar = await cookies();
  jar.set({
    name: COOKIE_NAME,
    value: minted.plaintext,
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: MAX_AGE_SECONDS,
  });
  return minted.plaintext;
}

/** Revokes the row and clears the cookie. Idempotent. */
export async function clearSessionCookie(): Promise<void> {
  const jar = await cookies();
  const value = jar.get(COOKIE_NAME)?.value;
  if (value && isWellFormedSession(value)) {
    const tokenHash = hashToken(value);
    await db
      .update(sessions)
      .set({ revokedAt: sql`now()` })
      .where(and(eq(sessions.tokenHash, tokenHash), isNull(sessions.revokedAt)));
  }
  jar.delete(COOKIE_NAME);
}

function readClientIp(hdrs: Awaited<ReturnType<typeof headers>>): string | null {
  return clientIpFromHeaders((n) => hdrs.get(n));
}
