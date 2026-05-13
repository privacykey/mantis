import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const PREFIX = "mantis_live_";

export function mintApiKey(): { plaintext: string; prefix: string; hash: string } {
  const body = randomBytes(24).toString("base64url");
  const plaintext = PREFIX + body;
  return {
    plaintext,
    prefix: plaintext.slice(0, PREFIX.length + 6),
    hash: hashApiKey(plaintext),
  };
}

export function hashApiKey(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex");
}

export function verifyApiKey(plaintext: string, expectedHash: string): boolean {
  const a = Buffer.from(hashApiKey(plaintext), "hex");
  const b = Buffer.from(expectedHash, "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function isWellFormedApiKey(value: string): boolean {
  return value.startsWith(PREFIX) && value.length > PREFIX.length + 16;
}
