import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// Envelope encryption for operator secrets stored in the DB (webhook HMAC
// signing secrets, Apple Wallet auth secret + cert passphrase). The wrapping
// key lives only in the environment (MANTIS_SECRET_KEY), so a DB-only
// compromise (leaked backup, read replica) no longer yields usable secrets —
// the same trust model that already protects MANTIS_API_KEY_PEPPER.
//
// Backward compatible by design:
//   - MANTIS_SECRET_KEY UNSET  → sealSecret() is a no-op (returns plaintext);
//     openSecret() passes plaintext through. Existing deployments are unchanged.
//   - MANTIS_SECRET_KEY SET     → new writes are encrypted; reads transparently
//     decrypt ciphertext and pass through any legacy plaintext rows. Rotating a
//     signing secret or re-saving the wallet config migrates a row to encrypted.

const PREFIX = "encv1:";
const IV_LEN = 12;
const TAG_LEN = 16;

function secretKey(): Buffer | null {
  const raw = process.env.MANTIS_SECRET_KEY;
  if (!raw) return null;
  const buf = /^[0-9a-f]{64}$/i.test(raw)
    ? Buffer.from(raw, "hex")
    : Buffer.from(raw, "base64");
  if (buf.length !== 32) {
    throw new Error(
      "MANTIS_SECRET_KEY must decode to 32 bytes (generate with `openssl rand -base64 32`)",
    );
  }
  return buf;
}

/** True when at-rest secret encryption is configured. */
export function secretEncryptionEnabled(): boolean {
  return secretKey() !== null;
}

/** True if a stored value is in the encrypted envelope format. */
export function isSealed(stored: string): boolean {
  return stored.startsWith(PREFIX);
}

/**
 * Encrypt a secret for storage with AES-256-GCM. No-op (returns the plaintext
 * unchanged) when MANTIS_SECRET_KEY is unset, so callers can wrap every write
 * unconditionally.
 */
export function sealSecret(plaintext: string): string {
  const key = secretKey();
  if (!key) return plaintext;
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, ct, tag]).toString("base64");
}

/**
 * Decrypt a stored secret. Values without the envelope prefix are treated as
 * legacy plaintext and returned unchanged. Throws if an encrypted value is
 * encountered but MANTIS_SECRET_KEY is missing (operator removed the key).
 */
export function openSecret(stored: string): string {
  if (!isSealed(stored)) return stored; // legacy plaintext
  const key = secretKey();
  if (!key) {
    throw new Error(
      "encountered an encrypted secret but MANTIS_SECRET_KEY is not set",
    );
  }
  const blob = Buffer.from(stored.slice(PREFIX.length), "base64");
  if (blob.length < IV_LEN + TAG_LEN) throw new Error("sealed secret too short");
  const iv = blob.subarray(0, IV_LEN);
  const tag = blob.subarray(blob.length - TAG_LEN);
  const ct = blob.subarray(IV_LEN, blob.length - TAG_LEN);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

/** open if non-null, else null. */
export function openSecretOrNull(stored: string | null): string | null {
  return stored === null ? null : openSecret(stored);
}
