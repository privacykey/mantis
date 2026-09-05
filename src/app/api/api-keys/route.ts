import { desc, eq } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";
import { db } from "@/db/client";
import { apiKeys } from "@/db/schema";
import { requireApiKey } from "@/lib/auth";
import { mintApiKey } from "@/lib/api-keys";
import { audit } from "@/lib/audit";
import { extractIp } from "@/lib/request-info";
import {
  BodyParseError,
  BodyTooLargeError,
  MAX_API_JSON_BYTES,
  readBodyJson,
} from "@/lib/safe-body";
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
      scope: apiKeys.scope,
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
    body = await readBodyJson(req, MAX_API_JSON_BYTES);
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      return NextResponse.json(
        { error: "payload_too_large", message: err.message },
        { status: 413 },
      );
    }
    if (err instanceof BodyParseError) {
      return NextResponse.json(
        { error: "bad_request", message: "invalid JSON body" },
        { status: 400 },
      );
    }
    throw err;
  }

  const parsed = createApiKeySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation_error", issues: parsed.error.issues },
      { status: 422 },
    );
  }

  // Minting is admin-only. A non-admin that could mint siblings would keep a
  // foothold after its own key is revoked (rows carry no lineage, so
  // revocation can't cascade), and "enroll" keys are fleet credentials an
  // operator should hand out deliberately. Self-revoke stays open to everyone.
  const wantsAdmin = parsed.data.is_admin === true;
  if (!auth.key.isAdmin) {
    return NextResponse.json(
      {
        error: "forbidden",
        message: "only an admin API key can mint API keys",
      },
      { status: 403 },
    );
  }

  const minted = mintApiKey();
  const scope = parsed.data.scope ?? "full";
  const [row] = await db
    .insert(apiKeys)
    .values({
      name: parsed.data.name,
      prefix: minted.prefix,
      hash: minted.hash,
      isAdmin: wantsAdmin,
      scope,
    })
    .returning({
      id: apiKeys.id,
      name: apiKeys.name,
      prefix: apiKeys.prefix,
      is_admin: apiKeys.isAdmin,
      scope: apiKeys.scope,
      created_at: apiKeys.createdAt,
    });

  if (row) {
    await audit({
      type: "api_key.created",
      actorApiKeyId: auth.key.id,
      actorLabel: auth.key.name,
      subjectKind: "api_key",
      subjectId: row.id,
      metadata: {
        name: row.name,
        prefix: row.prefix,
        is_admin: wantsAdmin,
        scope,
      },
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
