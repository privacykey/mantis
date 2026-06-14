import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  isSealed,
  openSecret,
  sealSecret,
  secretEncryptionEnabled,
} from "@/lib/secret-box";

// A valid 32-byte key, base64-encoded.
const KEY = Buffer.alloc(32, 7).toString("base64");

describe("secret-box (MANTIS_SECRET_KEY unset)", () => {
  const orig = process.env.MANTIS_SECRET_KEY;
  beforeEach(() => delete process.env.MANTIS_SECRET_KEY);
  afterEach(() => {
    if (orig === undefined) delete process.env.MANTIS_SECRET_KEY;
    else process.env.MANTIS_SECRET_KEY = orig;
  });

  it("is a no-op: sealSecret returns plaintext unchanged", () => {
    expect(secretEncryptionEnabled()).toBe(false);
    expect(sealSecret("hunter2")).toBe("hunter2");
    expect(isSealed(sealSecret("hunter2"))).toBe(false);
  });

  it("passes legacy plaintext through openSecret", () => {
    expect(openSecret("legacy-plaintext-secret")).toBe("legacy-plaintext-secret");
  });
});

describe("secret-box (MANTIS_SECRET_KEY set)", () => {
  const orig = process.env.MANTIS_SECRET_KEY;
  beforeEach(() => {
    process.env.MANTIS_SECRET_KEY = KEY;
  });
  afterEach(() => {
    if (orig === undefined) delete process.env.MANTIS_SECRET_KEY;
    else process.env.MANTIS_SECRET_KEY = orig;
  });

  it("round-trips: openSecret(sealSecret(x)) === x", () => {
    const secret = "s3cr3t-signing-key/with+base64==chars";
    const sealed = sealSecret(secret);
    expect(secretEncryptionEnabled()).toBe(true);
    expect(isSealed(sealed)).toBe(true);
    expect(sealed).not.toContain(secret);
    expect(openSecret(sealed)).toBe(secret);
  });

  it("produces a fresh nonce each call (no ciphertext reuse)", () => {
    expect(sealSecret("same")).not.toBe(sealSecret("same"));
  });

  it("still passes legacy plaintext through (mixed-state deployment)", () => {
    expect(openSecret("legacy-plaintext")).toBe("legacy-plaintext");
  });

  it("rejects a tampered ciphertext (GCM auth)", () => {
    const sealed = sealSecret("authentic");
    const tampered = sealed.slice(0, -2) + (sealed.endsWith("AA") ? "BB" : "AA");
    expect(() => openSecret(tampered)).toThrow();
  });

  it("accepts a hex-encoded key too", () => {
    process.env.MANTIS_SECRET_KEY = Buffer.alloc(32, 9).toString("hex");
    expect(openSecret(sealSecret("x"))).toBe("x");
  });

  it("rejects a wrong-length key", () => {
    process.env.MANTIS_SECRET_KEY = Buffer.alloc(16, 1).toString("base64");
    expect(() => sealSecret("x")).toThrow(/32 bytes/);
  });
});
