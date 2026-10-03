import { and, desc, eq, gt, inArray, lt, or, sql } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";
import { db } from "@/db/client";
import { keys, notificationDestinations } from "@/db/schema";
import { canAccessKey, requireApiKey } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { isEnrollKey, sameFleet } from "@/lib/fleet";
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
  createDestination,
  createKeyWithDestinations,
  listDestinations,
  serializeResult,
} from "@/lib/notify/destinations";
import { createKeySchema, listQuerySchema } from "@/lib/validators";
import { encodeHitCursor, parseHitCursor } from "@/lib/hit-cursor";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Enrollment-scoped keys ship on every managed device and are assumed
// extracted. They mint a plain tripwire only: lifecycle, monitoring, trigger
// response content and alert routing are operator decisions.
const ENROLL_FIELDS = new Set([
  "memo",
  "external_id",
  "response_kind",
  "dedupe_window_seconds",
  "destinations",
]);
const ENROLL_MAX_DEDUPE_SECONDS = 600;
// The `mantis:device:` namespace belongs to the device flows (dashboard and
// `mantis device new`), which run with a full key.
const DEVICE_EXTERNAL_ID_PREFIX = "mantis:device:";
const DEFAULT_ENROLL_KEYS_PER_HOUR = 1000;

/**
 * Destinations an admin pre-approved for enrollment-scoped keys:
 * MANTIS_ENROLL_DESTINATIONS is a whitespace-separated list of
 * "channel:target" pairs. Empty (the default) means enroll keys cannot attach
 * destinations at all, and fleet alerts are routed by global destinations.
 */
function approvedEnrollDestinations(): Set<string> {
  return new Set(
    (process.env.MANTIS_ENROLL_DESTINATIONS ?? "")
      .split(/\s+/)
      .filter(Boolean),
  );
}

/** New keys one enroll credential may create per hour (0 disables the cap). */
function enrollKeysPerHour(): number {
  const raw = process.env.MANTIS_ENROLL_KEYS_PER_HOUR;
  if (!raw) return DEFAULT_ENROLL_KEYS_PER_HOUR;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : DEFAULT_ENROLL_KEYS_PER_HOUR;
}

function forbiddenForEnroll(message: string): NextResponse {
  return NextResponse.json({ error: "forbidden", message }, { status: 403 });
}

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

  if (isEnroll) {
    const extra = Object.entries(input)
      .filter(([k, v]) => v !== null && !ENROLL_FIELDS.has(k))
      .map(([k]) => k);
    if (
      extra.length > 0 ||
      (input.response_kind !== undefined &&
        input.response_kind !== "gif" &&
        input.response_kind !== "empty") ||
      (input.dedupe_window_seconds ?? 0) > ENROLL_MAX_DEDUPE_SECONDS ||
      input.external_id?.startsWith(DEVICE_EXTERNAL_ID_PREFIX)
    ) {
      return forbiddenForEnroll(
        `enrollment-scoped keys may only set memo, external_id, response_kind (gif or empty), a dedupe window up to ${ENROLL_MAX_DEDUPE_SECONDS} s and pre-approved destinations`,
      );
    }
  }
  if (input.adopt !== undefined && !auth.key.isAdmin) {
    return NextResponse.json(
      { error: "forbidden", message: "only an admin API key can adopt" },
      { status: 403 },
    );
  }

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
  // Each distinct destination is stored and pinged once, however often the
  // request repeats it.
  const destinationInputs = [
    ...new Map(
      (input.destinations ?? []).map((d) => [`${d.channel}:${d.target}`, d]),
    ).values(),
  ];

  if (isEnroll) {
    // Checked before anything is inserted or sent: creating a destination
    // makes the server deliver an activation message to it.
    if (destinationInputs.length > 0) {
      const approved = approvedEnrollDestinations();
      const i = destinationInputs.findIndex(
        (d) => !approved.has(`${d.channel}:${d.target}`),
      );
      if (i !== -1) {
        return forbiddenForEnroll(
          `destinations[${i}] is not an approved enrollment destination`,
        );
      }
    }
    const perHour = enrollKeysPerHour();
    if (perHour > 0) {
      const [recent] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(keys)
        .where(
          and(
            eq(keys.createdByApiKeyId, auth.key.id),
            gt(keys.createdAt, sql`now() - interval '1 hour'`),
          ),
        );
      // Re-claims of an existing external_id stay free; only new keys count.
      if ((recent?.count ?? 0) >= perHour && !(await externalIdExists(input.external_id))) {
        return NextResponse.json(
          {
            error: "rate_limited",
            message: "this enrollment key has created too many keys in the last hour",
          },
          { status: 429, headers: { "Retry-After": "600" } },
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
    ...(input.self_origins !== undefined
      ? { selfOrigins: input.self_origins }
      : {}),
    createdByApiKeyId: auth.key.id,
  };

  // external_id makes creation idempotent. On a conflict, return the existing
  // key without changing its destinations. On a new key, both the key and its
  // destinations commit in one transaction.
  const created = input.external_id
    ? await createKeyWithDestinations(insertValues, destinationInputs, {
        onExternalIdConflict: true,
      })
    : await createKeyWithDestinations(insertValues, destinationInputs);
  const row = created.key;

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
    // Who may re-claim an existing external_id (see lib/fleet.ts):
    //   - its creator: yes;
    //   - an enrollment-scoped key from the same fleet: the reduced shape,
    //     WITHOUT the memo unless it created the key. This is the documented
    //     fleet flow (a re-imaged Mac recovers its trigger URL by serial;
    //     enroll keys get rotated — see deploy/kandji/README.md) and is
    //     audited as a cross-key claim;
    //   - an admin: rows from the operators' own fleet, or any row with an
    //     explicit `adopt: true`;
    //   - anyone else: bare 409. External ids are guessable (hostnames,
    //     serials). A key from another fleet has no business learning this
    //     row's memo and trigger URL, and a fleet must never arm a device
    //     with a key that somebody outside it created first.
    const createdByCaller = existing.createdByApiKeyId === auth.key.id;
    const inFleet =
      createdByCaller ||
      ((isEnroll || auth.key.isAdmin) &&
        (await sameFleet(auth.key, existing.createdByApiKeyId)));
    const adopted = !inFleet && auth.key.isAdmin && input.adopt === true;
    const mayClaim = inFleet || adopted;
    const owner = canAccessKey(auth.key, existing);
    // A disabled or expired key never alerts. Handing it back as the device's
    // tripwire would arm nothing while every consumer reports success.
    const dead =
      existing.disabledAt !== null ||
      (existing.expiresAt !== null &&
        existing.expiresAt.getTime() <= Date.now());
    await audit({
      type: "key.claimed",
      actorApiKeyId: auth.key.id,
      actorLabel: auth.key.name,
      subjectKind: "key",
      subjectId: existing.id,
      metadata: {
        external_id: input.external_id,
        ...(mayClaim && owner ? { memo: existing.memo } : {}),
        ...(mayClaim && !createdByCaller ? { cross_key: true } : {}),
        ...(adopted ? { adopted: true } : {}),
        ...(mayClaim && dead ? { dead: true } : {}),
        ...(!mayClaim || dead ? { denied: true } : {}),
      },
      ip: extractIp(req),
    });
    if (!mayClaim) {
      return NextResponse.json(
        {
          error: "conflict",
          message: "external_id is already in use by a key you cannot access",
        },
        { status: 409 },
      );
    }
    if (dead) {
      return NextResponse.json(
        {
          error: "conflict",
          message:
            "external_id belongs to a disabled or expired key; an operator must enable or delete it",
        },
        { status: 409 },
      );
    }
    if (isEnroll) {
      // Whoever holds the fleet's enroll key can claim a serial before the
      // real device does, and that first claim may have carried no
      // destination. Top the key up with any approved destination this claim
      // carries, so pre-claiming cannot leave a device's alarm unrouted. Only
      // for keys an enroll key created: a claim never changes what an
      // operator configured, and never removes or replaces anything.
      if (
        destinationInputs.length > 0 &&
        (await isEnrollKey(existing.createdByApiKeyId))
      ) {
        const have = new Set(
          (await listDestinations(existing.id)).map(
            (d) => `${d.channel}:${d.target}`,
          ),
        );
        const added = destinationInputs.filter(
          (d) => !have.has(`${d.channel}:${d.target}`),
        );
        for (const d of added) {
          // The activation result is persisted on the destination row; a
          // failed ping must not fail the device's enrollment.
          await createDestination(existing, d).catch(() => {});
        }
        if (added.length > 0) {
          await audit({
            type: "destinations.replaced",
            actorApiKeyId: auth.key.id,
            actorLabel: auth.key.name,
            subjectKind: "key",
            subjectId: existing.id,
            metadata: {
              added: added.length,
              channels: added.map((d) => d.channel),
              via: "enroll_claim",
            },
            ip: extractIp(req),
          });
        }
      }
      return NextResponse.json(
        {
          ...serializeKeyForEnroll(existing, { includeMemo: createdByCaller }),
          reused: true,
          created_by_caller: createdByCaller,
        },
        { status: 200 },
      );
    }
    const existingDests = await listDestinations(existing.id);
    return NextResponse.json(
      {
        ...serializeKey(existing, existingDests),
        reused: true,
        created_by_caller: createdByCaller,
      },
      { status: 200 },
    );
  }

  if (!row) {
    return NextResponse.json(
      { error: "internal", message: "insert returned no row" },
      { status: 500 },
    );
  }

  const results = created.results;

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
    // No transport error text either: it describes the server's view of the
    // network, which a fleet-embedded credential has no need for.
    return NextResponse.json(
      {
        ...serializeKeyForEnroll(row),
        reused: false,
        destinations: results.map((r) => ({
          ...serializeResult(r),
          last_activation_error: null,
          activation: { ok: r.activation.ok },
        })),
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

async function externalIdExists(externalId: string | undefined): Promise<boolean> {
  if (!externalId) return false;
  const [row] = await db
    .select({ id: keys.id })
    .from(keys)
    .where(eq(keys.externalId, externalId))
    .limit(1);
  return row !== undefined;
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
  const keyCursor = cursor ? parseHitCursor(cursor) : null;
  if (cursor && !keyCursor) {
    return NextResponse.json({ error: "validation_error", message: "invalid cursor" }, { status: 422 });
  }

  // Non-admin keys see only their own; admins see all. See lib/auth.canAccessKey.
  // ?mine=1 restricts any caller, admins included, to keys it created (the
  // CLI's `last` must never resolve to a key another credential minted).
  const mine = url.searchParams.get("mine") === "1";
  const ownerClause =
    auth.key.isAdmin && !mine
      ? undefined
      : eq(keys.createdByApiKeyId, auth.key.id);
  const cursorAt = keyCursor ? sql`${keyCursor.at}::timestamptz` : null;
  const cursorClause = keyCursor && cursorAt
    ? keyCursor.id
      ? or(lt(keys.createdAt, cursorAt), and(eq(keys.createdAt, cursorAt), lt(keys.id, keyCursor.id)))
      : lt(keys.createdAt, cursorAt)
    : undefined;
  const whereClause =
    ownerClause && cursorClause
      ? and(ownerClause, cursorClause)
      : (ownerClause ?? cursorClause);
  const rows = await db
    .select({ key: keys, cursorTime: sql<string>`to_char(${keys.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')` })
    .from(keys)
    .where(whereClause)
    .orderBy(desc(keys.createdAt), desc(keys.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const slice = hasMore ? rows.slice(0, limit) : rows;

  let destByKey = new Map<string, typeof notificationDestinations.$inferSelect[]>();
  if (slice.length > 0) {
    const keyIds = slice.map(({ key }) => key.id);
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

  const data = slice.map(({ key }) => serializeKey(key, destByKey.get(key.id) ?? []));
  const nextCursor = hasMore
    ? encodeHitCursor(rows[limit - 1]!.cursorTime, rows[limit - 1]!.key.id)
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
