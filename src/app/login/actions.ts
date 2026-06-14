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
  // Postgres-backed so the cap holds across instances / serverless cold
  // starts (the in-memory limiter under-counted there). Fails open on DB error.
  const rl = await consumeRateLimit(`login:${ip ?? "anonymous"}`, {
    limit: 10,
    windowMs: 60_000,
  });
  if (!rl.ok) {
    return { error: "too many attempts — try again in a minute" };
  }

  const raw = formData.get("api_key");
  const key = typeof raw === "string" ? raw.trim() : "";

  if (!key) return { error: "API key is required" };
  if (!isWellFormedApiKey(key)) {
    return { error: "doesn't look like a mantis_live_… key" };
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
    return { error: "invalid or revoked API key" };
  }

  const apiKeyRow = rows[0]!;
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
