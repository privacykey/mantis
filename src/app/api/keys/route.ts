import { and, desc, eq, inArray, lt } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";
import { db } from "@/db/client";
import { keys, notificationDestinations } from "@/db/schema";
import { canAccessKey, requireApiKey } from "@/lib/auth";
import { audit } from "@/lib/audit";
import {
  newPublicId,
  serializeKey,
  serializeKeyForEnroll,
} from "@/lib/keys";
import { validateDestination } from "@/lib/notify/channels";
import { extractIp } from "@/lib/request-info";
import {
  BodyParseError,
  BodyTooLargeError,
  MAX_API_JSON_BYTES,
  readBodyJson,
} from "@/lib/safe-body";
import {
  listDestinations,
  replaceDestinations,
  serializeResult,
} from "@/lib/notify/destinations";
import { createKeySchema, listQuerySchema } from "@/lib/validators";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  // The one route enrollment-scoped keys may call (see lib/auth.ts).
  const auth = await requireApiKey(req, { allowEnroll: true });
  if (!auth.ok) return auth.res;
  const isEnroll = auth.key.scope === "enroll";

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

  const insertValues = {
    publicId: newPublicId(),
    memo: input.memo,
    externalId: input.external_id ?? null,
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
  };

  // external_id makes creation idempotent: the unique constraint absorbs the
  // duplicate insert and we return the existing row instead. Everything else
  // in the body (memo, destinations, …) applies only when the row is actually
  // created — a claim never mutates what IT configured on the existing key.
  const [row] = input.external_id
    ? await db
        .insert(keys)
        .values(insertValues)
        .onConflictDoNothing({ target: keys.externalId })
        .returning()
    : await db.insert(keys).values(insertValues).returning();

  if (!row && input.external_id) {
    const [existing] = await db
      .select()
      .from(keys)
      .where(eq(keys.externalId, input.external_id))
      .limit(1);
    if (!existing) {
      // The conflicting row was deleted between our insert and select.
      return NextResponse.json(
        {
          error: "conflict",
          message: "enrollment raced a concurrent delete — retry",
        },
        { status: 409 },
      );
    }
    // Who may re-claim an existing external_id:
    //   - its creator or an admin: yes (full shape for full keys, reduced
    //     shape for enroll keys — no alert routing either way);
    //   - an enrollment-scoped key that did not create it: the reduced shape
    //     WITHOUT the memo. This is the documented fleet flow (a re-imaged
    //     Mac recovers its trigger URL by serial; enroll keys get rotated —
    //     see deploy/kandji/README.md) and is audited as a cross-key claim;
    //   - any other full key: bare 409. External ids are guessable (hostnames,
    //     serials), and a full key that owns nothing here has no business
    //     learning another tenant's memo and trigger URL, which is enough to
    //     fire false alarms on their tripwire.
    const owner = canAccessKey(auth.key, existing);
    const crossKeyEnroll = !owner && isEnroll;
    await audit({
      type: "key.claimed",
      actorApiKeyId: auth.key.id,
      actorLabel: auth.key.name,
      subjectKind: "key",
      subjectId: existing.id,
      metadata: {
        external_id: input.external_id,
        ...(owner ? { memo: existing.memo } : {}),
        ...(crossKeyEnroll ? { cross_key: true } : {}),
        ...(!owner && !isEnroll ? { denied: true } : {}),
      },
      ip: extractIp(req),
    });
    if (!owner && !isEnroll) {
      return NextResponse.json(
        {
          error: "conflict",
          message: "external_id is already in use by a key you cannot access",
        },
        { status: 409 },
      );
    }
    if (isEnroll) {
      return NextResponse.json(
        {
          ...serializeKeyForEnroll(existing, { includeMemo: owner }),
          reused: true,
        },
        { status: 200 },
      );
    }
    const existingDests = await listDestinations(existing.id);
    return NextResponse.json(
      { ...serializeKey(existing, existingDests), reused: true },
      { status: 200 },
    );
  }

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
      ...(row.externalId ? { external_id: row.externalId } : {}),
      destination_count: dests.length,
      destination_channels: dests.map((d) => d.channel),
    },
    ip: extractIp(req),
  });

  if (isEnroll) {
    // Reduced shape + activation status for the destinations this caller just
    // supplied. No signing-secret reveal: fleet-embedded keys never see
    // signing material (an admin can rotate the secret later to obtain one).
    return NextResponse.json(
      {
        ...serializeKeyForEnroll(row),
        reused: false,
        destinations: results.map((r) => serializeResult(r)),
      },
      { status: 201 },
    );
  }

  return NextResponse.json(
    {
      ...serializeKey(row, dests),
      reused: false,
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
    // keyId is nullable (NULL = a global destination), but the inArray filter
    // above already excludes those — this narrows the type and keeps the
    // per-key listing showing only destinations the key itself owns.
    destByKey = groupBy(
      allDests.filter((d): d is typeof d & { keyId: string } => d.keyId !== null),
      (d) => d.keyId,
    );
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
