import { eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { db } from "@/db/client";
import { hits, keys, type Key } from "@/db/schema";
import { decideHitRecording } from "@/lib/hits";
import { verifyAuthToken } from "@/lib/installers/apple-wallet";
import { loadActiveWalletConfig } from "@/lib/installers/wallet-store";
import { log } from "@/lib/log";
import { enqueueNotifications } from "@/lib/notify";
import { rateLimit } from "@/lib/rate-limit";
import {
  capStoredRequestField,
  extractIp,
  snapshotHeaders,
} from "@/lib/request-info";
import { parseUserAgent } from "@/lib/ua";

const PASS_TYPE_ID_RE = /^[A-Za-z0-9._-]+$/;
const SERIAL_RE = /^[A-Za-z0-9]+$/;

// Per-key + per-IP cap on Wallet callbacks. A .pkpass embeds a long-lived
// authenticationToken that any pass holder possesses, so without this a single
// pass can loop the fetch/heartbeat endpoints into a notification flood and
// unbounded hits-table growth.
const WALLET_RATE_LIMIT = { limit: 60, windowMs: 60_000 } as const;

export type WalletAuthResult =
  | { ok: true; key: Key }
  | { ok: false; status: number; body?: object };

/**
 * Authenticates and resolves a Wallet callback against the mantis key it's
 * referencing. Wallet sends `Authorization: ApplePass <token>` per pass; we
 * verify the token against the HMAC-derived expected value.
 */
export async function authenticateWalletRequest(
  req: NextRequest,
  passTypeId: string,
  serial: string,
): Promise<WalletAuthResult> {
  const cfg = await loadActiveWalletConfig();
  if (!cfg) return { ok: false, status: 503 };

  if (!PASS_TYPE_ID_RE.test(passTypeId) || passTypeId !== cfg.passTypeId) {
    return { ok: false, status: 401 };
  }
  if (!SERIAL_RE.test(serial)) {
    return { ok: false, status: 401 };
  }

  const authHeader = req.headers.get("authorization") ?? "";
  const m = /^ApplePass\s+(\S+)$/.exec(authHeader);
  if (!m) return { ok: false, status: 401 };
  const presented = m[1]!;

  const [key] = await db
    .select()
    .from(keys)
    .where(eq(keys.publicId, serial))
    .limit(1);
  if (!key) return { ok: false, status: 401 };

  if (!verifyAuthToken(key.id, cfg.authSecret, presented)) {
    return { ok: false, status: 401 };
  }
  return { ok: true, key };
}

/**
 * Records a Wallet-originated hit and enqueues notifications, mirroring what
 * the public trigger endpoint does. Caller passes the Wallet event label
 * ("wallet-registered" / "wallet-fetched" / "wallet-heartbeat" / "wallet-unregistered").
 */
export async function recordWalletHit(
  req: NextRequest,
  key: Key,
  walletSource: string,
): Promise<void> {
  if (key.disabledAt !== null) return;
  if (key.expiresAt && key.expiresAt.getTime() < Date.now()) return;

  const ip = extractIp(req);

  // Flood guard: a pass holder can loop these callbacks indefinitely.
  if (!rateLimit(`wallet:${key.id}:${ip ?? "anon"}`, WALLET_RATE_LIMIT).ok) {
    return;
  }

  // Honour the key's dedupe window so repeated wallet events within it don't
  // each fire a notification (mirrors the public trigger path). Notifications
  // only fire on the primary, non-duplicate record.
  let decision = await decideHitRecording(
    key.id,
    key.dedupeWindowSeconds,
  ).catch((err) => {
    log.error({ err, keyId: key.id }, "wallet duplicate-window check failed");
    return { record: true, isDuplicate: false } as const;
  });
  if (!decision.record) return;

  const userAgent = capStoredRequestField(req.headers.get("user-agent"));
  const referer = capStoredRequestField(req.headers.get("referer"));
  const headers = snapshotHeaders(req);
  headers["x-mantis-source"] = walletSource;
  const ua = parseUserAgent(userAgent);

  try {
    const [hit] = await db
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
        isDuplicate: decision.isDuplicate,
      })
      .returning();
    if (hit && !decision.isDuplicate) {
      try {
        await enqueueNotifications(key, hit);
      } catch (err) {
        log.error({ err, hitId: hit.id }, "wallet enqueue failed");
      }
    }
  } catch (err) {
    log.error({ err, keyId: key.id }, "wallet hit insert failed");
  }
}
