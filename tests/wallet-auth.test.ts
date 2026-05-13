import { describe, expect, it } from "vitest";
import { deriveAuthToken, verifyAuthToken } from "@/lib/installers/apple-wallet";

describe("Apple Wallet auth token", () => {
  const secret = "test-secret-must-be-at-least-16-chars-long";
  const keyId = "00000000-0000-0000-0000-000000000001";

  it("derives the same token for the same input", () => {
    const a = deriveAuthToken(keyId, secret);
    const b = deriveAuthToken(keyId, secret);
    expect(a).toBe(b);
  });

  it("produces different tokens for different key ids", () => {
    const a = deriveAuthToken(keyId, secret);
    const b = deriveAuthToken("00000000-0000-0000-0000-000000000002", secret);
    expect(a).not.toBe(b);
  });

  it("produces different tokens for different secrets", () => {
    const a = deriveAuthToken(keyId, "secret-a");
    const b = deriveAuthToken(keyId, "secret-b");
    expect(a).not.toBe(b);
  });

  it("verifies a matching token", () => {
    const tok = deriveAuthToken(keyId, secret);
    expect(verifyAuthToken(keyId, secret, tok)).toBe(true);
  });

  it("rejects a wrong token", () => {
    expect(verifyAuthToken(keyId, secret, "wrong-token")).toBe(false);
  });

  it("rejects a token derived with a different secret", () => {
    const tok = deriveAuthToken(keyId, "wrong-secret-XXXXXXXXXXXXXXXX");
    expect(verifyAuthToken(keyId, secret, tok)).toBe(false);
  });

  it("rejects a tampered token of same length", () => {
    const tok = deriveAuthToken(keyId, secret);
    const tampered = tok.slice(0, -1) + (tok.endsWith("a") ? "b" : "a");
    expect(verifyAuthToken(keyId, secret, tampered)).toBe(false);
  });

  it("rejects a token of different length without throwing", () => {
    expect(verifyAuthToken(keyId, secret, "short")).toBe(false);
    expect(verifyAuthToken(keyId, secret, "")).toBe(false);
  });

  it("produces a token of length 32 (b64url, trimmed)", () => {
    expect(deriveAuthToken(keyId, secret)).toHaveLength(32);
  });
});
