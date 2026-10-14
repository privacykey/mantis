import { eq } from "drizzle-orm";
import { type NextRequest } from "next/server";
import { db } from "@/db/client";
import { keys, type Key } from "@/db/schema";
import { recordHitWithNotifications } from "@/lib/hits";
import { log } from "@/lib/log";
import { rateLimit } from "@/lib/rate-limit";
import {
  capStoredRequestField,
  extractIp,
  snapshotHeaders,
} from "@/lib/request-info";
import { buildTriggerResponse } from "@/lib/response";
import { parseUserAgent } from "@/lib/ua";

// Shared by /c/[publicId] and /c/[publicId]/[...rest]. Lives outside route.ts
// because a route module may only export HTTP method handlers + route config.

const SAFE_ID_RE = /^[A-Za-z0-9]{6,32}$/;

// Per-key (+IP) cap on the record/notify path; over-cap requests still get the
// key's real response but skip recording.
const TRIGGER_RATE_LIMIT = { limit: 120, windowMs: 60_000 } as const;

// Cap for the synthetic x-mantis-* values lifted out of the request URL (the
// appended path and the clone detector's ?l= / ?r=). They are attacker-supplied
// free text, so keep them well under the per-field header cap.
const MAX_URL_CONTEXT_CHARS = 2048;

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

function capUrlContext(value: string): string {
  return value.length <= MAX_URL_CONTEXT_CHARS
    ? value
    : value.slice(0, MAX_URL_CONTEXT_CHARS);
}

/**
 * The public trigger. `appendedPath` is whatever followed `<prefix>/<publicId>`
 * when the request came in through the catch-all route (a tool that treats the
 * bait URL as a base URL and appends its own path); it is stored with the hit
 * and never changes the response.
 */
export async function handleTrigger(
  req: NextRequest,
  publicId: string,
  appendedPath: string | null = null,
): Promise<Response> {
  // Malformed ids never need DB work and must not spend any shared budget.
  if (!SAFE_ID_RE.test(publicId)) return buildTriggerResponse("gif", null);

  const ip = extractIp(req);

  // Deliberately NO per-IP drop before the lookup. A budget keyed only on the
  // client IP is shared by every canary that fires from that IP (one NAT
  // egress, or a spoofable header behind a non-stripping proxy), so junk
  // requests from the attacker's side of the NAT would silence every live
  // canary behind it. Nothing may be shed before we know whether the request
  // addresses a live key; unknown ids cost one indexed lookup and nothing else.
  let key: Key | null = null;
  try {
    key = await lookupKey(publicId);
  } catch (err) {
    log.error({ err, publicId }, "lookup failed");
    return new Response(null, { status: 503, headers: { "Retry-After": "1", "Cache-Control": "no-store" } });
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

  // The js-clone-detector beacon reports the cloning page as ?l=<location>
  // and ?r=<document.referrer>. Keep them with the hit (they are the only
  // record of the clone's URL when the page suppresses Referer).
  const pageUrl = req.nextUrl.searchParams.get("l");
  if (pageUrl) headers["x-mantis-page-url"] = capUrlContext(pageUrl);
  const pageReferrer = req.nextUrl.searchParams.get("r");
  if (pageReferrer) headers["x-mantis-page-referrer"] = capUrlContext(pageReferrer);

  // What the consuming tool appended to the bait URL (an S3 bucket/object, a
  // REST operation, an app API path) — often the most telling part of the hit.
  if (appendedPath) headers["x-mantis-request-path"] = capUrlContext(appendedPath);

  try {
    await recordHitWithNotifications(key, {
      ip, userAgent, referer, headers,
      uaBrowser: ua.browser, uaBrowserVersion: ua.browserVersion,
      uaOs: ua.os, uaDevice: ua.device, botLabel: ua.botLabel,
    });
  } catch (err) {
    log.error({ err, keyId: key.id }, "failed to capture hit and delivery jobs");
    return new Response(null, { status: 503, headers: { "Retry-After": "1", "Cache-Control": "no-store" } });
  }

  return buildTriggerResponse(
    key.responseKind,
    key.responsePayload as unknown,
  );
}
