import { eq } from "drizzle-orm";
import { type NextRequest, after } from "next/server";
import { db } from "@/db/client";
import { hits, keys, type Hit, type Key } from "@/db/schema";
import { decideHitRecording, type HitRecordDecision } from "@/lib/hits";
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

  // Per-IP flood guard before the DB lookup, to shed load from a single
  // abusive source. Enforced only when we actually have a trusted client IP:
  // without one, every request would share a single "anonymous" bucket, and an
  // unauthenticated flood of /c/<anything> could silence (blind) EVERY canary
  // instance-wide once the cap was hit. In that case we fail open here and rely
  // on the per-key guard + dedupe window below, which bound work per key
  // without ever suppressing a different key's notification. Over-cap → silent
  // GIF so the limiter isn't observable through response-shape differences.
  if (ip !== null && !rateLimit(`trigger:ip:${ip}`, TRIGGER_RATE_LIMIT).ok) {
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

  // Per-key flood guard on the record/notify path. Scoped to this key (and IP
  // when present) so flooding one canary can never blind another, and a missing
  // client IP can't collapse every canary into a single bucket. The first hit
  // in a window has already enqueued a notification and the dedupe window below
  // bounds per-key notification volume, so shedding the flood's extra recording
  // work here costs no genuine alert. Over-cap → still serve the key's real
  // response (the caller already knows the key exists) but skip record/notify.
  if (!rateLimit(`trigger:key:${key.publicId}:${ip ?? "anon"}`, TRIGGER_RATE_LIMIT).ok) {
    return buildTriggerResponse(key.responseKind, key.responsePayload as unknown);
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
