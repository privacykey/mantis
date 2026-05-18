import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { env } from "./env";

const PREFIX = "mantis_live_";

/**
 * API keys are 192-bit random tokens prefixed with "mantis_live_". We never
 * store the plaintext — only a server-side HMAC-SHA-256 of it under the
 * `MANTIS_API_KEY_PEPPER` secret. Compared to plain SHA-256, the pepper
 * means a leaked database alone can't be brute-forced: the attacker also
 * needs the env secret. Compared to bcrypt/argon2, HMAC keeps the lookup
 * deterministic so we can index by hash and do an O(1) query at auth time.
 *
 * Migration story (SHA-256 era → HMAC era):
 *   - `hashApiKey` always produces v2 (HMAC). New mints use v2.
 *   - `legacySha256ApiKey` reproduces the old v1 SHA-256 hash so a v1
 *     stored row can still be looked up.
 *   - `verifyApiKey(plain, storedHash)` tries v2 first, then v1.
 *   - Callers that look up by hash should query for either form (see
 *     `resolveByPlaintext` in `src/lib/auth.ts`).
 */

export function mintApiKey(): { plaintext: string; prefix: string; hash: string } {
  const body = randomBytes(24).toString("base64url");
  const plaintext = PREFIX + body;
  return {
    plaintext,
    prefix: plaintext.slice(0, PREFIX.length + 6),
    hash: hashApiKey(plaintext),
  };
}

/** v2 hash — HMAC-SHA-256 under the server pepper. Use this for new rows. */
export function hashApiKey(plaintext: string): string {
  return createHmac("sha256", env.apiKeyPepper).update(plaintext).digest("hex");
}

/**
 * v1 hash — pre-pepper SHA-256. Kept for dual-mode lookup of rows minted
 * before MANTIS_API_KEY_PEPPER existed. Don't use for new mints.
 */
export function legacySha256ApiKey(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex");
}

/**
 * Verify a presented plaintext against a stored hash. Returns true if either
 * the v2 (HMAC) or v1 (SHA-256) form matches — both are 64-char hex so we
 * can't tell them apart by shape; we just try both in constant time.
 */
export function verifyApiKey(plaintext: string, expectedHash: string): boolean {
  const stored = Buffer.from(expectedHash, "hex");
  const v2 = Buffer.from(hashApiKey(plaintext), "hex");
  if (v2.length === stored.length && timingSafeEqual(v2, stored)) return true;
  const v1 = Buffer.from(legacySha256ApiKey(plaintext), "hex");
  if (v1.length === stored.length && timingSafeEqual(v1, stored)) return true;
  return false;
}

export function isWellFormedApiKey(value: string): boolean {
  return value.startsWith(PREFIX) && value.length > PREFIX.length + 16;
}
