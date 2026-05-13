import { describe, expect, it } from "vitest";
import { b64urlDecode, b64urlEncode, seal, unseal } from "../src/seal";

describe("AES-256-GCM seal/unseal", () => {
  async function freshKey(): Promise<Uint8Array> {
    const k = new Uint8Array(32);
    crypto.getRandomValues(k);
    return k;
  }

  function bytes(s: string): Uint8Array {
    return new TextEncoder().encode(s);
  }

  function text(b: Uint8Array): string {
    return new TextDecoder().decode(b);
  }

  it("round-trips a small JSON payload", async () => {
    const key = await freshKey();
    const original = JSON.stringify({ w: "https://example.com/hook", r: "gif" });
    const sealed = await seal(bytes(original), key);
    const opened = await unseal(sealed, key);
    expect(text(opened)).toBe(original);
  });

  it("produces different ciphertexts for the same plaintext (nonce-randomness)", async () => {
    const key = await freshKey();
    const pt = bytes("the same plaintext");
    const a = await seal(pt, key);
    const b = await seal(pt, key);
    expect(b64urlEncode(a)).not.toBe(b64urlEncode(b));
  });

  it("rejects tampered ciphertext (auth-tag mismatch)", async () => {
    const key = await freshKey();
    const sealed = await seal(bytes("hello"), key);
    const tampered = new Uint8Array(sealed);
    // Flip a bit somewhere in the ciphertext (after version + nonce).
    tampered[15] = tampered[15]! ^ 0x01;
    await expect(unseal(tampered, key)).rejects.toThrow();
  });

  it("rejects ciphertext with wrong key", async () => {
    const key1 = await freshKey();
    const key2 = await freshKey();
    const sealed = await seal(bytes("hello"), key1);
    await expect(unseal(sealed, key2)).rejects.toThrow();
  });

  it("rejects truncated ciphertext", async () => {
    const key = await freshKey();
    const sealed = await seal(bytes("hello"), key);
    await expect(unseal(sealed.subarray(0, 5), key)).rejects.toThrow(/too short/);
  });

  it("rejects wrong version byte", async () => {
    const key = await freshKey();
    const sealed = new Uint8Array(await seal(bytes("hello"), key));
    sealed[0] = 0x99;
    await expect(unseal(sealed, key)).rejects.toThrow(/bad version/);
  });
});

describe("base64url helpers", () => {
  it("round-trips", () => {
    const original = new Uint8Array([0, 1, 2, 0xff, 0xab, 0xcd]);
    const encoded = b64urlEncode(original);
    expect(encoded).not.toMatch(/[+/=]/); // no standard-b64 chars
    const decoded = b64urlDecode(encoded);
    expect(Array.from(decoded)).toEqual(Array.from(original));
  });

  it("decodes a string with no padding", () => {
    const decoded = b64urlDecode("SGVsbG8");
    expect(new TextDecoder().decode(decoded)).toBe("Hello");
  });

  it("handles empty input", () => {
    expect(b64urlEncode(new Uint8Array(0))).toBe("");
    expect(b64urlDecode("")).toEqual(new Uint8Array(0));
  });
});
