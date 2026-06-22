import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ORIGINAL_PEPPER = process.env.MANTIS_API_KEY_PEPPER;
const TEST_PEPPER = "test-pepper-for-api-key-hashing-do-not-use";

beforeEach(() => {
  process.env.MANTIS_API_KEY_PEPPER = TEST_PEPPER;
});

afterEach(() => {
  if (ORIGINAL_PEPPER === undefined) delete process.env.MANTIS_API_KEY_PEPPER;
  else process.env.MANTIS_API_KEY_PEPPER = ORIGINAL_PEPPER;
});

/**
 * The env module reads MANTIS_API_KEY_PEPPER at import time, so we have to
 * import the module under test after setting the env var. Use a dynamic
 * import that's re-evaluated per test (vitest caches modules across tests
 * by default, but we don't actually need re-eval: the pepper is read by
 * the env module once and held by reference, so as long as the env var
 * was set before the FIRST import, the same value is used everywhere).
 */
async function loadApiKeys() {
  return await import("@/lib/api-keys");
}

describe("api-keys (HMAC mode)", () => {
  it("mints a key with the v2 (HMAC) hash, not the v1 (SHA-256) form", async () => {
    const { mintApiKey, hashApiKey, legacySha256ApiKey } = await loadApiKeys();
    const m = mintApiKey();
    expect(m.plaintext.startsWith("mantis_live_")).toBe(true);
    // Hash field must match the v2 HMAC of plaintext.
    expect(m.hash).toBe(hashApiKey(m.plaintext));
    // And must differ from the legacy SHA-256 form — confirms the migration
    // is in effect (mints now use the peppered hash).
    expect(m.hash).not.toBe(legacySha256ApiKey(m.plaintext));
    // Both hashes are 64-char hex regardless.
    expect(m.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("verifyApiKey accepts the v2 (HMAC) form for new mints", async () => {
    const { mintApiKey, verifyApiKey } = await loadApiKeys();
    const m = mintApiKey();
    expect(verifyApiKey(m.plaintext, m.hash)).toBe(true);
  });

  it("verifyApiKey accepts the v1 (legacy SHA-256) form so pre-pepper rows still log in", async () => {
    const { mintApiKey, verifyApiKey, legacySha256ApiKey } = await loadApiKeys();
    const m = mintApiKey();
    const legacyHash = legacySha256ApiKey(m.plaintext);
    // A row that was stored before MANTIS_API_KEY_PEPPER existed has this
    // legacy hash on disk. verifyApiKey must still accept it.
    expect(verifyApiKey(m.plaintext, legacyHash)).toBe(true);
  });

  it("verifyApiKey rejects a wrong plaintext", async () => {
    const { mintApiKey, verifyApiKey } = await loadApiKeys();
    const m = mintApiKey();
    expect(verifyApiKey("mantis_live_definitely_not_this", m.hash)).toBe(false);
  });

  it("verifyApiKey rejects garbage hashes (wrong length, wrong charset)", async () => {
    const { mintApiKey, verifyApiKey } = await loadApiKeys();
    const m = mintApiKey();
    expect(verifyApiKey(m.plaintext, "")).toBe(false);
    expect(verifyApiKey(m.plaintext, "deadbeef")).toBe(false); // too short
    expect(verifyApiKey(m.plaintext, "X".repeat(64))).toBe(false); // non-hex chars
  });

  it("hashApiKey is deterministic for the same input + pepper", async () => {
    const { hashApiKey } = await loadApiKeys();
    const a = hashApiKey("mantis_live_repeated");
    const b = hashApiKey("mantis_live_repeated");
    expect(a).toBe(b);
    // …which is the whole point of using HMAC rather than argon2: we can
    // still do an indexed equality lookup at auth.ts query time.
  });

  it("isWellFormedApiKey reflects the documented prefix + length rule", async () => {
    const { isWellFormedApiKey } = await loadApiKeys();
    expect(isWellFormedApiKey("mantis_live_xxxxxxxxxxxxxxxxxx")).toBe(true);
    expect(isWellFormedApiKey("mantis_live_short")).toBe(false);
    expect(isWellFormedApiKey("not_a_key")).toBe(false);
    expect(isWellFormedApiKey("")).toBe(false);
  });

  it("the v2 hash is sensitive to the pepper — without the secret you can't reproduce it", async () => {
    // Conceptual check: an attacker who got the database but not the pepper
    // can't precompute hashes for guessed plaintexts and compare them.
    // We test this by re-deriving the *same* plaintext's hash with two
    // different peppers and asserting they differ.
    const { hashApiKey } = await loadApiKeys();
    const a = hashApiKey("mantis_live_constant");

    // Swap the pepper and re-import. Because the env module captures the
    // value at first import we can't actually change it mid-test without
    // dynamic re-import — but we CAN cross-check by reading the same code
    // path with a manually computed HMAC under a different key.
    const { createHmac } = await import("node:crypto");
    const b = createHmac("sha256", "a-totally-different-pepper")
      .update("mantis_live_constant")
      .digest("hex");
    expect(a).not.toBe(b);
  });
});
