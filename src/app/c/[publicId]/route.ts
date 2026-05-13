import { and, desc, eq, gt, sql } from "drizzle-orm";
import { type NextRequest, after } from "next/server";
import { db } from "@/db/client";
import { hits, keys, type Hit, type Key } from "@/db/schema";
import { log } from "@/lib/log";
import { enqueueNotifications } from "@/lib/notify";
import { rateLimit } from "@/lib/rate-limit";
import {
  capStoredRequestField,
  extractIp,
  snapshotHeaders,
} from "@/lib/request-info";
import { buildTriggerResponse } from "@/lib/response";
import { parseUserAgent } from "@/lib/ua";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Ctx = { params: Promise<{ publicId: string }> };

const SAFE_ID_RE = /^[A-Za-z0-9]{6,32}$/;

// Generous per-IP cap on the public trigger; floods drop to a silent GIF.
const TRIGGER_RATE_LIMIT = { limit: 120, windowMs: 60_000 } as const;
const DEFAULT_DUPLICATE_LOG_LIMIT = 10;

async function lookupKey(publicId: string): Promise<Key | null> {
  if (!SAFE_ID_RE.test(publicId)) return null;
  const [row] = await db
    .select()
    .from(keys)
    .where(eq(keys.publicId, publicId))
    .limit(1);
  return row ?? null;
}

function shouldFire(key: Key): boolean {
  if (key.disabledAt !== null) return false;
  if (key.expiresAt && key.expiresAt.getTime() < Date.now()) return false;
  return true;
}

type HitRecordDecision =
  | { record: true; isDuplicate: boolean }
  | { record: false; isDuplicate: true };

function duplicateLogLimit(): number {
  const raw = process.env.MANTIS_DUPLICATE_LOG_LIMIT;
  if (!raw) return DEFAULT_DUPLICATE_LOG_LIMIT;
  const n = Number(raw);
  if (!Number.isInteger(n)) return DEFAULT_DUPLICATE_LOG_LIMIT;
  return Math.min(1000, Math.max(0, n));
}

async function decideHitRecording(
  keyId: string,
  windowSeconds: number,
): Promise<HitRecordDecision> {
  if (windowSeconds <= 0) return { record: true, isDuplicate: false };
  const since = sql<Date>`now() - (${windowSeconds}::int * interval '1 second')`;
  const [row] = await db
    .select({ id: hits.id, occurredAt: hits.occurredAt })
    .from(hits)
    .where(
      and(
        eq(hits.keyId, keyId),
        gt(hits.occurredAt, since),
        eq(hits.isDuplicate, false),
      ),
    )
    .orderBy(desc(hits.occurredAt))
    .limit(1);
  if (!row) return { record: true, isDuplicate: false };

  const limit = duplicateLogLimit();
  if (limit <= 0) return { record: false, isDuplicate: true };

  const [dupes] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(hits)
    .where(
      and(
        eq(hits.keyId, keyId),
        gt(hits.occurredAt, row.occurredAt),
        eq(hits.isDuplicate, true),
      ),
    );

  const duplicateCount = dupes?.count ?? 0;
  return duplicateCount < limit
    ? { record: true, isDuplicate: true }
    : { record: false, isDuplicate: true };
}

export async function GET(req: NextRequest, ctx: Ctx) {
  const { publicId } = await ctx.params;
  return handle(req, publicId);
}

export async function HEAD(req: NextRequest, ctx: Ctx) {
  const { publicId } = await ctx.params;
  return handle(req, publicId);
}

export async function POST(req: NextRequest, ctx: Ctx) {
  const { publicId } = await ctx.params;
  return handle(req, publicId);
}

async function handle(req: NextRequest, publicId: string): Promise<Response> {
  const ip = extractIp(req);

  // Rate-limit before the DB lookup. Over-cap → silent GIF so the limiter's
  // engagement isn't observable through response-shape differences.
  const rl = rateLimit(`trigger:${ip ?? "anonymous"}`, TRIGGER_RATE_LIMIT);
  if (!rl.ok) {
    return buildTriggerResponse("gif", null);
  }

  let key: Key | null = null;
  try {
    key = await lookupKey(publicId);
  } catch (err) {
    log.error({ err, publicId }, "lookup failed");
  }

  if (!key || !shouldFire(key)) {
    return buildTriggerResponse("gif", null);
  }

  const userAgent = capStoredRequestField(req.headers.get("user-agent"));
  const referer = capStoredRequestField(req.headers.get("referer"));
  const headers = snapshotHeaders(req);
  const ua = parseUserAgent(userAgent);

  // ?src=<label> from header-less installers (NFC tags, email pixels) is
  // promoted to a synthetic X-Mantis-Source so host_context reads uniform.
  const rawSrc = req.nextUrl.searchParams.get("src");
  if (
    rawSrc &&
    !headers["x-mantis-source"] &&
    /^[A-Za-z0-9_-]{1,40}$/.test(rawSrc)
  ) {
    headers["x-mantis-source"] = rawSrc;
  }

  let recordDecision: HitRecordDecision = {
    record: true,
    isDuplicate: false,
  };
  try {
    recordDecision = await decideHitRecording(
      key.id,
      key.dedupeWindowSeconds,
    );
  } catch (err) {
    log.error({ err, keyId: key.id }, "failed to evaluate duplicate window");
  }

  let hit: Hit | null = null;
  if (recordDecision.record) {
    try {
      const [row] = await db
        .insert(hits)
        .values({
          keyId: key.id,
          ip,
          userAgent,
          referer,
          headers,
          uaBrowser: ua.browser,
          uaBrowserVersion: ua.browserVersion,
          uaOs: ua.os,
          uaDevice: ua.device,
          botLabel: ua.botLabel,
          isDuplicate: recordDecision.isDuplicate,
        })
        .returning();
      hit = row ?? null;
    } catch (err) {
      log.error({ err, keyId: key.id }, "failed to insert hit");
    }
  }

  if (hit && !recordDecision.isDuplicate) {
    const capturedKey = key;
    const capturedHit = hit;
    after(async () => {
      try {
        await enqueueNotifications(capturedKey, capturedHit);
      } catch (err) {
        log.error({ err, hitId: capturedHit.id }, "enqueue failed");
      }
    });
  }

  return buildTriggerResponse(
    key.responseKind,
    key.responsePayload as unknown,
  );
}
