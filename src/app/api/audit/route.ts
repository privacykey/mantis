import { and, desc, eq, gt, lt, sql } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";
import { db } from "@/db/client";
import { auditEvents } from "@/db/schema";
import { requireApiKeyOrSession } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_LIMIT = 500;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_LIMIT = 100;

/**
 * GET /api/audit
 *
 *   ?limit=<n>           page size (default 100, max 500)
 *   ?cursor=<iso>        keyset cursor: occurred_at strictly older than this
 *   ?since=<iso>         filter: occurred_at strictly after this
 *   ?event_type=<type>   filter by event_type (repeat for OR)
 *   ?actor=<api_key_id>  filter by actor api_key_id
 *
 * Admin-gated: non-admin API keys 403. Audit visibility belongs to whoever
 * is operating the instance, not to the keys that get audited.
 */
export async function GET(req: NextRequest) {
  const auth = await requireApiKeyOrSession(req);
  if (!auth.ok) return auth.res;
  if (!auth.key.isAdmin) {
    return NextResponse.json(
      { error: "forbidden", message: "audit log is admin-only" },
      { status: 403 },
    );
  }

  const url = new URL(req.url);
  const rawLimit = Number(url.searchParams.get("limit") ?? DEFAULT_LIMIT);
  const limit = Math.max(
    1,
    Math.min(Number.isFinite(rawLimit) ? rawLimit : DEFAULT_LIMIT, MAX_LIMIT),
  );

  const conditions = [] as Array<ReturnType<typeof eq>>;

  const cursor = url.searchParams.get("cursor");
  if (cursor) {
    const t = Date.parse(cursor);
    if (!Number.isNaN(t)) {
      conditions.push(lt(auditEvents.occurredAt, new Date(t)));
    }
  }

  const since = url.searchParams.get("since");
  if (since) {
    const t = Date.parse(since);
    if (!Number.isNaN(t)) {
      conditions.push(gt(auditEvents.occurredAt, new Date(t)));
    }
  }

  const eventTypes = url.searchParams.getAll("event_type");
  if (eventTypes.length === 1) {
    conditions.push(eq(auditEvents.eventType, eventTypes[0]!));
  } else if (eventTypes.length > 1) {
    conditions.push(
      sql`${auditEvents.eventType} IN (${sql.join(
        eventTypes.map((t) => sql`${t}`),
        sql`, `,
      )})`,
    );
  }

  const actor = url.searchParams.get("actor");
  if (actor) {
    if (!UUID_RE.test(actor)) {
      return NextResponse.json(
        { error: "validation_error", message: "actor must be a full UUID" },
        { status: 422 },
      );
    }
    conditions.push(eq(auditEvents.actorApiKeyId, actor));
  }

  const rows = await db
    .select()
    .from(auditEvents)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(auditEvents.occurredAt))
    .limit(limit + 1);

  const overflow = rows.length > limit;
  const data = overflow ? rows.slice(0, limit) : rows;
  const nextCursor = overflow ? data[data.length - 1]!.occurredAt.toISOString() : null;

  return NextResponse.json({
    data: data.map((r) => ({
      id: r.id,
      occurred_at: r.occurredAt.toISOString(),
      event_type: r.eventType,
      actor_api_key_id: r.actorApiKeyId,
      actor_label: r.actorLabel,
      subject_kind: r.subjectKind,
      subject_id: r.subjectId,
      metadata: r.metadata,
      ip: r.ip,
    })),
    next_cursor: nextCursor,
  });
}
