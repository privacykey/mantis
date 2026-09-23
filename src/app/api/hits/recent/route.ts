import { and, desc, eq, gt, inArray, lt, or, sql, type SQL } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";
import { db } from "@/db/client";
import { hits, keys, notifications, type Notification } from "@/db/schema";
import { requireApiKeyOrSession } from "@/lib/auth";
import { parseHostContext } from "@/lib/installers/headers";
import { hitNotificationSerializer } from "@/lib/notify/redact";
import { encodeHitCursor, parseHitCursor } from "@/lib/hit-cursor";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const cursorTime = sql<string>`to_char(${hits.occurredAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

export async function GET(req: NextRequest) {
  const auth = await requireApiKeyOrSession(req);
  if (!auth.ok) return auth.res;

  const url = new URL(req.url);
  const parsed = parseQuery(url.searchParams);
  if (!parsed.ok) {
    return NextResponse.json(
      { error: "validation_error", message: parsed.message },
      { status: 422 },
    );
  }

  // Capture database time before reading hits. Live clients use this as their
  // first watermark so their local clocks cannot hide new arrivals.
  const anchor = url.searchParams.get("anchor") === "1"
    ? (await db.select({ at: sql<Date>`clock_timestamp()` }).from(sql`(select 1) as anchor_clock`))[0]
    : undefined;

  const conditions: SQL[] = [];
  if (!auth.key.isAdmin) {
    conditions.push(eq(keys.createdByApiKeyId, auth.key.id));
  }
  if (parsed.keyId) {
    conditions.push(eq(keys.id, parsed.keyId));
  }
  if (parsed.since) {
    conditions.push(parsed.sinceId
      ? or(gt(hits.occurredAt, parsed.since), and(eq(hits.occurredAt, parsed.since), gt(hits.id, parsed.sinceId)))!
      : gt(hits.occurredAt, parsed.since));
  }
  if (parsed.cursor) {
    const at = sql`${parsed.cursor.at}::timestamptz`;
    conditions.push(parsed.cursor.id
      ? or(lt(hits.occurredAt, at), and(eq(hits.occurredAt, at), lt(hits.id, parsed.cursor.id)))!
      : lt(hits.occurredAt, at));
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;
  const rows = await db
    .select({
      hit: hits,
      cursorTime,
      key: {
        id: keys.id,
        publicId: keys.publicId,
        memo: keys.memo,
      },
    })
    .from(hits)
    .innerJoin(keys, eq(hits.keyId, keys.id))
    .where(where)
    .orderBy(desc(hits.occurredAt), desc(hits.id))
    .limit(parsed.limit + 1);

  const hasMore = rows.length > parsed.limit;
  const data = hasMore ? rows.slice(0, parsed.limit) : rows;
  const hitIds = data.map((row) => row.hit.id);

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
    ? (rows[parsed.limit - 1]
      ? encodeHitCursor(rows[parsed.limit - 1]!.cursorTime, rows[parsed.limit - 1]!.hit.id)
      : null)
    : null;

  return NextResponse.json({
    data: data.map(({ hit, key }) => ({
      id: hit.id,
      key: {
        id: key.id,
        public_id: key.publicId,
        memo: key.memo,
      },
      occurred_at: hit.occurredAt,
      ip: hit.ip,
      user_agent: hit.userAgent,
      referer: hit.referer,
      headers: hit.headers,
      ua_browser: hit.uaBrowser,
      ua_browser_version: hit.uaBrowserVersion,
      ua_os: hit.uaOs,
      ua_device: hit.uaDevice,
      bot_label: hit.botLabel,
      is_duplicate: hit.isDuplicate,
      host_context: parseHostContext(hit.headers as Record<string, string> | null),
      notifications: (notifyByHit.get(hit.id) ?? []).map(serializeNotification),
    })),
    next_cursor: nextCursor,
    ...(anchor ? { server_time: anchor.at.toISOString() } : {}),
  });
}

function parseQuery(params: URLSearchParams):
  | {
      ok: true;
      limit: number;
      since: Date | null;
      sinceId: string | null;
      cursor: { at: string; id: string | null } | null;
      keyId: string | null;
    }
  | { ok: false; message: string } {
  const limitRaw = params.get("limit") ?? "100";
  const limit = Number(limitRaw);
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    return { ok: false, message: "limit must be an integer from 1 to 500" };
  }

  const keyId = params.get("key_id");
  if (keyId && !UUID_RE.test(keyId)) {
    return { ok: false, message: "key_id must be a full UUID" };
  }

  const since = parseOptionalDate(params.get("since"));
  if (since === false) {
    return { ok: false, message: "since must be an ISO timestamp" };
  }

  const sinceId = params.get("since_id");
  if (sinceId && (!UUID_RE.test(sinceId) || !since)) {
    return { ok: false, message: "since_id requires a valid since timestamp and UUID" };
  }
  const cursorRaw = params.get("cursor");
  const cursor = cursorRaw ? parseHitCursor(cursorRaw) : null;
  if (cursorRaw && !cursor) {
    return { ok: false, message: "cursor must be an ISO timestamp or hit cursor" };
  }

  return {
    ok: true,
    limit,
    since,
    sinceId,
    cursor,
    keyId: keyId ?? null,
  };
}

function parseOptionalDate(raw: string | null): Date | null | false {
  if (!raw) return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? false : date;
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
