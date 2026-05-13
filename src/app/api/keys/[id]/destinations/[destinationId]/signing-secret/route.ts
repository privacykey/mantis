import { and, eq } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";
import { db } from "@/db/client";
import { notificationDestinations } from "@/db/schema";
import { audit } from "@/lib/audit";
import { loadOwnedKey, requireApiKeyOrSession } from "@/lib/auth";
import { extractIp } from "@/lib/request-info";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Ctx = { params: Promise<{ id: string; destinationId: string }> };

/** Returns the plaintext signing secret. Each reveal is audited. */
export async function POST(req: NextRequest, ctx: Ctx) {
  const auth = await requireApiKeyOrSession(req);
  if (!auth.ok) return auth.res;

  const { id, destinationId } = await ctx.params;
  if (!UUID_RE.test(destinationId)) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const ownedKey = await loadOwnedKey(auth.key, id);
  if (!ownedKey) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const [row] = await db
    .select()
    .from(notificationDestinations)
    .where(
      and(
        eq(notificationDestinations.id, destinationId),
        eq(notificationDestinations.keyId, id),
      ),
    )
    .limit(1);

  if (!row || row.channel !== "webhook" || !row.signingSecret) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  await audit({
    type: "destination.secret_revealed",
    actorApiKeyId: auth.key.id,
    actorLabel: auth.key.name,
    subjectKind: "destination",
    subjectId: destinationId,
    metadata: { key_id: id, channel: row.channel },
    ip: extractIp(req),
  });

  return NextResponse.json(
    { signing_secret: row.signingSecret },
    { headers: { "Cache-Control": "no-store" } },
  );
}
