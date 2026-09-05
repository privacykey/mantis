import { and, desc, eq, inArray, lt } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";
import { db } from "@/db/client";
import { hits, notifications, type Notification } from "@/db/schema";
import { loadOwnedKey, requireApiKey } from "@/lib/auth";
import { parseHostContext } from "@/lib/installers/headers";
import { hitNotificationSerializer } from "@/lib/notify/redact";
import { listQuerySchema } from "@/lib/validators";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  const auth = await requireApiKey(req);
  if (!auth.ok) return auth.res;

  const { id } = await ctx.params;
  const ownedKey = await loadOwnedKey(auth.key, id);
  if (!ownedKey) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const url = new URL(req.url);
  const parsed = listQuerySchema.safeParse({
    limit: url.searchParams.get("limit") ?? undefined,
    cursor: url.searchParams.get("cursor") ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation_error", issues: parsed.error.issues },
      { status: 422 },
    );
  }
  const { limit, cursor } = parsed.data;

  const conditions = [eq(hits.keyId, id)];
  if (cursor) conditions.push(lt(hits.occurredAt, new Date(cursor)));

  const rows = await db
    .select()
    .from(hits)
    .where(and(...conditions))
    .orderBy(desc(hits.occurredAt))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  const hitIds = data.map((h) => h.id);

  let notifyByHit = new Map<string, Notification[]>();
  let allNotifs: Notification[] = [];
  if (hitIds.length > 0) {
    allNotifs = await db
      .select()
      .from(notifications)
      .where(inArray(notifications.hitId, hitIds));
    notifyByHit = groupByHit(allNotifs);
  }
  // Global-destination targets are admin credentials; non-admins get them
  // redacted (see lib/notify/redact.ts).
  const serializeNotification = await hitNotificationSerializer(allNotifs, auth.key);

  const nextCursor = hasMore
    ? (rows[limit - 1]?.occurredAt.toISOString() ?? null)
    : null;

  return NextResponse.json({
    data: data.map((h) => ({
      id: h.id,
      occurred_at: h.occurredAt,
      ip: h.ip,
      user_agent: h.userAgent,
      referer: h.referer,
      headers: h.headers,
      ua_browser: h.uaBrowser,
      ua_browser_version: h.uaBrowserVersion,
      ua_os: h.uaOs,
      ua_device: h.uaDevice,
      bot_label: h.botLabel,
      is_duplicate: h.isDuplicate,
      host_context: parseHostContext(h.headers as Record<string, string> | null),
      notifications: (notifyByHit.get(h.id) ?? []).map(serializeNotification),
    })),
    next_cursor: nextCursor,
  });
}

function groupByHit(rows: Notification[]): Map<string, Notification[]> {
  const m = new Map<string, Notification[]>();
  for (const r of rows) {
    const arr = m.get(r.hitId);
    if (arr) arr.push(r);
    else m.set(r.hitId, [r]);
  }
  return m;
}
