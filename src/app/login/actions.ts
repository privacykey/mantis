"use server";

import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { db } from "@/db/client";
import { apiKeys } from "@/db/schema";
import {
  hashApiKey,
  isWellFormedApiKey,
  legacySha256ApiKey,
} from "@/lib/api-keys";
import { audit } from "@/lib/audit";
import { consumeRateLimit } from "@/lib/rate-limit";
import { clientIpFromHeaders } from "@/lib/request-info";
import { setSessionCookie } from "@/lib/session";

export type LoginState = { error?: string };

async function loginClientIp(): Promise<string | null> {
  // Server actions can't reach NextRequest; delegate to the shared helper so
  // the trust gate + rightmost-hop XFF parsing stay in one place.
  const h = await headers();
  return clientIpFromHeaders((n) => h.get(n));
}

export async function loginAction(
  _prev: LoginState,
  formData: FormData,
): Promise<LoginState> {
  const ip = await loginClientIp();

  // Throttle FAILED logins per IP, mirroring requireApiKey in src/lib/auth.ts:
  // the limiter is only consumed on a failed credential check, so a valid key
  // can never be hard-blocked by the bucket (and a flood of bad attempts can't
  // burn the operator's own quota). Postgres-backed (src/lib/rate-limit.ts) so
  // the cap holds across instances / serverless cold starts; fails open on DB
  // error. Enforced ONLY when we have a trusted client IP — without one
  // (TRUST_PROXY_HEADERS unset and not on Vercel, the production default) every
  // attempt would collapse into a single shared "login:anonymous" bucket, and
  // an unauthenticated flood could exhaust it and lock the operator out of the
  // dashboard. We fail open in that case, mirroring the trigger path in
  // src/app/c/[publicId]/route.ts; the per-key check below is the real gate.
  const fail = async (error: string): Promise<LoginState> => {
    if (ip !== null) {
      const rl = await consumeRateLimit(`login:${ip}`, {
        limit: 10,
        windowMs: 60_000,
      });
      if (!rl.ok) {
        return { error: "too many attempts — try again in a minute" };
      }
    }
    return { error };
  };

  const raw = formData.get("api_key");
  const key = typeof raw === "string" ? raw.trim() : "";

  if (!key) return fail("API key is required");
  if (!isWellFormedApiKey(key)) {
    return fail("doesn't look like a mantis_live_… key");
  }

  // Match either the current v2 (HMAC) or legacy v1 (SHA-256) stored hash.
  // Dual-mode for the same reason as resolveByPlaintext in src/lib/auth.ts —
  // existing rows from before MANTIS_API_KEY_PEPPER existed keep working,
  // and get opportunistically upgraded to v2 on the first successful login.
  const v2 = hashApiKey(key);
  const v1 = legacySha256ApiKey(key);
  const rows = await db
    .select()
    .from(apiKeys)
    .where(and(inArray(apiKeys.hash, [v2, v1]), isNull(apiKeys.revokedAt)))
    .limit(1);

  if (rows.length === 0) {
    return fail("invalid or revoked API key");
  }

  const apiKeyRow = rows[0]!;
  // Valid credential, wrong scope — reject without burning the per-IP
  // limiter, mirroring the 403 (not 401) in requireApiKey.
  if (apiKeyRow.scope === "enroll") {
    return {
      error: "enrollment-scoped keys can't log in to the dashboard",
    };
  }
  if (apiKeyRow.hash !== v2) {
    void db
      .update(apiKeys)
      .set({ hash: v2 })
      .where(eq(apiKeys.id, apiKeyRow.id))
      .catch(() => {});
  }
  await audit({
    type: "session.login",
    actorApiKeyId: apiKeyRow.id,
    actorLabel: apiKeyRow.name,
    subjectKind: "session",
    subjectId: apiKeyRow.id,
    ip,
  });
  await setSessionCookie(apiKeyRow.id);
  redirect("/keys");
}
