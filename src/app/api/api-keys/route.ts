import { desc, eq } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";
import { db } from "@/db/client";
import { apiKeys } from "@/db/schema";
import { requireApiKey } from "@/lib/auth";
import { mintApiKey } from "@/lib/api-keys";
import { audit } from "@/lib/audit";
import { extractIp } from "@/lib/request-info";
import { createApiKeySchema } from "@/lib/validators";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const auth = await requireApiKey(req);
  if (!auth.ok) return auth.res;

  // Non-admin keys see only their own row.
  const where = auth.key.isAdmin ? undefined : eq(apiKeys.id, auth.key.id);
  const rows = await db
    .select({
      id: apiKeys.id,
      name: apiKeys.name,
      prefix: apiKeys.prefix,
      is_admin: apiKeys.isAdmin,
      created_at: apiKeys.createdAt,
      last_used_at: apiKeys.lastUsedAt,
      revoked_at: apiKeys.revokedAt,
    })
    .from(apiKeys)
    .where(where)
    .orderBy(desc(apiKeys.createdAt));

  return NextResponse.json({ data: rows });
}

export async function POST(req: NextRequest) {
  const auth = await requireApiKey(req);
  if (!auth.ok) return auth.res;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "bad_request", message: "invalid JSON body" },
      { status: 400 },
    );
  }

  const parsed = createApiKeySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation_error", issues: parsed.error.issues },
      { status: 422 },
    );
  }

  // Only an admin may mint another admin.
  const wantsAdmin = parsed.data.is_admin === true;
  if (wantsAdmin && !auth.key.isAdmin) {
    return NextResponse.json(
      {
        error: "forbidden",
        message: "only an admin API key can mint another admin key",
      },
      { status: 403 },
    );
  }

  const minted = mintApiKey();
  const [row] = await db
    .insert(apiKeys)
    .values({
      name: parsed.data.name,
      prefix: minted.prefix,
      hash: minted.hash,
      isAdmin: wantsAdmin,
    })
    .returning({
      id: apiKeys.id,
      name: apiKeys.name,
      prefix: apiKeys.prefix,
      is_admin: apiKeys.isAdmin,
      created_at: apiKeys.createdAt,
    });

  if (row) {
    await audit({
      type: "api_key.created",
      actorApiKeyId: auth.key.id,
      actorLabel: auth.key.name,
      subjectKind: "api_key",
      subjectId: row.id,
      metadata: { name: row.name, prefix: row.prefix, is_admin: wantsAdmin },
      ip: extractIp(req),
    });
  }

  return NextResponse.json(
    {
      ...row,
      key: minted.plaintext,
      warning: "store this key now — it will not be shown again",
    },
    { status: 201 },
  );
}
