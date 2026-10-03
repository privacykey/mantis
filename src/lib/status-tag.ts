import { createHmac, timingSafeEqual } from "node:crypto";

// The capability in a monitor status URL: /status/<publicId>.<tag>. Kept apart
// from env.ts (which needs the whole server configuration at import time) so
// src/proxy.ts can check a status URL before any route handler runs.

/**
 * Capability for reading a key's monitor state at /status. The public id is
 * the bait (it is in every trigger URL), so it must not double as the read
 * capability: the tag is an HMAC of it under the server-held pepper, domain-
 * separated from the API-key hashes keyed with the same pepper.
 */
export function statusTag(publicId: string): string {
  const pepper = process.env.MANTIS_API_KEY_PEPPER;
  if (!pepper) throw new Error("Missing required env: MANTIS_API_KEY_PEPPER");
  return createHmac("sha256", pepper)
    .update(`mantis-status-v1:${publicId}`)
    .digest("base64url")
    .slice(0, 22);
}

const STATUS_TOKEN_RE = /^([A-Za-z0-9]{6,32})\.([A-Za-z0-9_-]{22})$/;

/**
 * The last path segment of a status URL is `<publicId>.<tag>`. Returns the
 * public id when the tag is the right one for it, else null. Touches no
 * database, so it can gate a request before anything else runs.
 */
export function statusPublicId(token: string): string | null {
  const m = STATUS_TOKEN_RE.exec(token);
  if (!m || !process.env.MANTIS_API_KEY_PEPPER) return null;
  const want = Buffer.from(statusTag(m[1]!));
  const got = Buffer.from(m[2]!);
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  return m[1]!;
}
