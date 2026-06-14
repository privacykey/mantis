import { eq } from "drizzle-orm";
import { type NextRequest, NextResponse, after } from "next/server";
import { db } from "@/db/client";
import { keys } from "@/db/schema";
import { loadOwnedKey, requireApiKey } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { notifyPassUpdate } from "@/lib/installers/wallet-push";
import { log } from "@/lib/log";
import { serializeKey } from "@/lib/keys";
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
import { updateKeySchema } from "@/lib/validators";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  const auth = await requireApiKey(req);
  if (!auth.ok) return auth.res;

  const { id } = await ctx.params;
  const row = await loadOwnedKey(auth.key, id);
  if (!row) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const destinations = await listDestinations(row.id);
  return NextResponse.json(serializeKey(row, destinations));
}

export async function PATCH(req: NextRequest, ctx: Ctx) {
  const auth = await requireApiKey(req);
  if (!auth.ok) return auth.res;

  const { id } = await ctx.params;
  const row = await loadOwnedKey(auth.key, id);
  if (!row) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

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

  const parsed = updateKeySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation_error", issues: parsed.error.issues },
      { status: 422 },
    );
  }
  const input = parsed.data;

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

  const patch: Partial<typeof keys.$inferInsert> = {};
  if (input.memo !== undefined) patch.memo = input.memo;
  if (input.response_kind !== undefined) patch.responseKind = input.response_kind;
  if (input.response_payload !== undefined) {
    patch.responsePayload = (input.response_payload ?? null) as object | null;
  }
  if (input.expires_at !== undefined) {
    patch.expiresAt = input.expires_at ? new Date(input.expires_at) : null;
  }
  if (input.dedupe_window_seconds !== undefined) {
    patch.dedupeWindowSeconds = input.dedupe_window_seconds;
  }
  if (input.monitor_mode !== undefined) {
    patch.monitorMode = input.monitor_mode;
  }
  if (input.monitor_window_seconds !== undefined) {
    patch.monitorWindowSeconds = input.monitor_window_seconds;
  }
  if (input.disabled !== undefined) {
    patch.disabledAt = input.disabled ? new Date() : null;
  }

  let updated = row;
  let passAffectingChange = false;
  if (Object.keys(patch).length > 0) {
    // Only memo / disabled affect what an installed Wallet pass renders.
    passAffectingChange =
      input.memo !== undefined || input.disabled !== undefined;

    const [u] = await db
      .update(keys)
      .set(patch)
      .where(eq(keys.id, id))
      .returning();
    if (!u) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    updated = u;
    if (input.disabled === true) {
      await audit({
        type: "key.disabled",
        actorApiKeyId: auth.key.id,
        actorLabel: auth.key.name,
        subjectKind: "key",
        subjectId: id,
        ip: extractIp(req),
      });
    } else if (input.disabled === false) {
      await audit({
        type: "key.enabled",
        actorApiKeyId: auth.key.id,
        actorLabel: auth.key.name,
        subjectKind: "key",
        subjectId: id,
        ip: extractIp(req),
      });
    } else {
      await audit({
        type: "key.updated",
        actorApiKeyId: auth.key.id,
        actorLabel: auth.key.name,
        subjectKind: "key",
        subjectId: id,
        metadata: { fields: Object.keys(patch) },
        ip: extractIp(req),
      });
    }
  }

  // Destinations replace the full set; activation pings fire on new entries.
  let destResults: ReturnType<typeof serializeResult>[] | null = null;
  if (input.destinations !== undefined) {
    const results = await replaceDestinations(updated, input.destinations);
    // Plaintext-secret reveal — only response shape that does this.
    destResults = results.map((r) => serializeResult(r, { reveal: true }));
    await audit({
      type: "destinations.replaced",
      actorApiKeyId: auth.key.id,
      actorLabel: auth.key.name,
      subjectKind: "key",
      subjectId: id,
      metadata: {
        count: results.length,
        channels: results.map((r) => r.destination.channel),
      },
      ip: extractIp(req),
    });
  }

  const destinations = await listDestinations(updated.id);
  const payload = serializeKey(updated, destinations);

  // Background APNs push so Wallet refetches the pass on installed devices.
  if (passAffectingChange) {
    after(async () => {
      try {
        await notifyPassUpdate(updated.id);
      } catch (err) {
        log.warn({ err, keyId: updated.id }, "pass-update push failed");
      }
    });
  }

  return NextResponse.json(
    destResults !== null ? { ...payload, destinations: destResults } : payload,
  );
}

export async function DELETE(req: NextRequest, ctx: Ctx) {
  const auth = await requireApiKey(req);
  if (!auth.ok) return auth.res;

  const { id } = await ctx.params;
  const existing = await loadOwnedKey(auth.key, id);
  if (!existing) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const result = await db.delete(keys).where(eq(keys.id, id)).returning({
    id: keys.id,
    memo: keys.memo,
  });
  if (result.length === 0) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  await audit({
    type: "key.deleted",
    actorApiKeyId: auth.key.id,
    actorLabel: auth.key.name,
    subjectKind: "key",
    subjectId: id,
    metadata: { memo: result[0]?.memo },
    ip: extractIp(req),
  });
  return new NextResponse(null, { status: 204 });
}
