import { and, desc, eq, inArray, lt } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";
import { db } from "@/db/client";
import { keys, notificationDestinations } from "@/db/schema";
import { requireApiKey } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { newPublicId, serializeKey } from "@/lib/keys";
import { validateDestination } from "@/lib/notify/channels";
import { extractIp } from "@/lib/request-info";
import {
  replaceDestinations,
  serializeResult,
} from "@/lib/notify/destinations";
import { createKeySchema, listQuerySchema } from "@/lib/validators";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

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

  const parsed = createKeySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation_error", issues: parsed.error.issues },
      { status: 422 },
    );
  }
  const input = parsed.data;

  // Per-channel target validation; zod only checks shape.
  if (input.destinations) {
    for (let i = 0; i < input.destinations.length; i++) {
      const d = input.destinations[i]!;
      const v = validateDestination(d.channel, d.target);
      if (!v.ok) {
        return NextResponse.json(
          {
            error: "validation_error",
            message: `destinations[${i}].target: ${v.error}`,
          },
          { status: 422 },
        );
      }
    }
  }

  const [row] = await db
    .insert(keys)
    .values({
      publicId: newPublicId(),
      memo: input.memo,
      responseKind: input.response_kind ?? "gif",
      responsePayload: (input.response_payload ?? null) as object | null,
      expiresAt: input.expires_at ? new Date(input.expires_at) : null,
      ...(input.dedupe_window_seconds !== undefined
        ? { dedupeWindowSeconds: input.dedupe_window_seconds }
        : {}),
      ...(input.monitor_mode !== undefined
        ? { monitorMode: input.monitor_mode }
        : {}),
      ...(input.monitor_window_seconds !== undefined
        ? { monitorWindowSeconds: input.monitor_window_seconds }
        : {}),
      createdByApiKeyId: auth.key.id,
    })
    .returning();

  if (!row) {
    return NextResponse.json(
      { error: "internal", message: "insert returned no row" },
      { status: 500 },
    );
  }

  // Insert destinations + run activation pings synchronously so the caller
  // gets per-destination status in the response.
  const results = input.destinations
    ? await replaceDestinations(row, input.destinations)
    : [];

  const dests = results.map((r) => r.destination);

  await audit({
    type: "key.created",
    actorApiKeyId: auth.key.id,
    actorLabel: auth.key.name,
    subjectKind: "key",
    subjectId: row.id,
    metadata: {
      memo: row.memo,
      response_kind: row.responseKind,
      destination_count: dests.length,
      destination_channels: dests.map((d) => d.channel),
    },
    ip: extractIp(req),
  });

  return NextResponse.json(
    {
      ...serializeKey(row, dests),
      // Plaintext-secret reveal — only response shape that exposes it.
      destinations: results.map((r) => serializeResult(r, { reveal: true })),
    },
    { status: 201 },
  );
}

export async function GET(req: NextRequest) {
  const auth = await requireApiKey(req);
  if (!auth.ok) return auth.res;

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

  // Non-admin keys see only their own; admins see all. See lib/auth.canAccessKey.
  const ownerClause = auth.key.isAdmin
    ? undefined
    : eq(keys.createdByApiKeyId, auth.key.id);
  const cursorClause = cursor ? lt(keys.createdAt, new Date(cursor)) : undefined;
  const whereClause =
    ownerClause && cursorClause
      ? and(ownerClause, cursorClause)
      : (ownerClause ?? cursorClause);
  const rows = await db
    .select()
    .from(keys)
    .where(whereClause)
    .orderBy(desc(keys.createdAt))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const slice = hasMore ? rows.slice(0, limit) : rows;

  let destByKey = new Map<string, typeof notificationDestinations.$inferSelect[]>();
  if (slice.length > 0) {
    const keyIds = slice.map((k) => k.id);
    const allDests = await db
      .select()
      .from(notificationDestinations)
      .where(inArray(notificationDestinations.keyId, keyIds));
    destByKey = groupBy(allDests, (d) => d.keyId);
  }

  const data = slice.map((k) => serializeKey(k, destByKey.get(k.id) ?? []));
  const nextCursor = hasMore
    ? (rows[limit - 1]?.createdAt.toISOString() ?? null)
    : null;

  return NextResponse.json({ data, next_cursor: nextCursor });
}

function groupBy<T, K extends string | number>(
  rows: T[],
  keyOf: (r: T) => K,
): Map<K, T[]> {
  const m = new Map<K, T[]>();
  for (const r of rows) {
    const k = keyOf(r);
    const arr = m.get(k);
    if (arr) arr.push(r);
    else m.set(k, [r]);
  }
  return m;
}
