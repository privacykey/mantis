import { and, eq, isNull } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";
import { db } from "@/db/client";
import { apiKeys } from "@/db/schema";
import { requireApiKey } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { extractIp } from "@/lib/request-info";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Ctx = { params: Promise<{ id: string }> };

export async function DELETE(req: NextRequest, ctx: Ctx) {
  const auth = await requireApiKey(req);
  if (!auth.ok) return auth.res;

  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  // Self-revoke is always allowed; revoking others requires admin.
  if (id !== auth.key.id && !auth.key.isAdmin) {
    return NextResponse.json(
      {
        error: "forbidden",
        message:
          "non-admin keys can only revoke themselves. Use an admin key to revoke others.",
      },
      { status: 403 },
    );
  }

  const [row] = await db
    .update(apiKeys)
    .set({ revokedAt: new Date() })
    .where(and(eq(apiKeys.id, id), isNull(apiKeys.revokedAt)))
    .returning({ id: apiKeys.id });

  if (!row) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  await audit({
    type: "api_key.revoked",
    actorApiKeyId: auth.key.id,
    actorLabel: auth.key.name,
    subjectKind: "api_key",
    subjectId: row.id,
    ip: extractIp(req),
  });

  return new NextResponse(null, { status: 204 });
}
