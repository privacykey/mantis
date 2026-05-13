"use server";

import { and, eq, isNull } from "drizzle-orm";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { db } from "@/db/client";
import { apiKeys } from "@/db/schema";
import { hashApiKey, isWellFormedApiKey } from "@/lib/api-keys";
import { audit } from "@/lib/audit";
import { rateLimit } from "@/lib/rate-limit";
import { setSessionCookie } from "@/lib/session";

export type LoginState = { error?: string };

async function loginClientIp(): Promise<string | null> {
  // Mirrors request-info.ts:extractIp — server actions can't reach NextRequest.
  const trust =
    process.env.TRUST_PROXY_HEADERS === "1" ||
    Boolean(process.env.VERCEL) ||
    process.env.NODE_ENV !== "production";
  if (!trust) return null;
  const h = await headers();
  return (
    h.get("cf-connecting-ip") ??
    h.get("x-vercel-forwarded-for") ??
    h.get("x-real-ip") ??
    h.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    null
  );
}

export async function loginAction(
  _prev: LoginState,
  formData: FormData,
): Promise<LoginState> {
  const ip = await loginClientIp();
  const rl = rateLimit(`login:${ip ?? "anonymous"}`, {
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

  const hash = hashApiKey(key);
  const rows = await db
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.hash, hash), isNull(apiKeys.revokedAt)))
    .limit(1);

  if (rows.length === 0) {
    return { error: "invalid or revoked API key" };
  }

  const apiKeyRow = rows[0]!;
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
