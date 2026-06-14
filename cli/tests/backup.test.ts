import { describe, expect, it } from "vitest";
import {
  openBundle,
  sealBundle,
  type BackupPayload,
} from "../src/lib/backup.js";

function samplePayload(): BackupPayload {
  return {
    $schema: "mantis-backup-v1",
    exportedAt: "2026-05-14T12:00:00.000Z",
    currentProfile: "primary",
    profiles: [
      {
        name: "primary",
        baseUrl: "https://mantis.example.com",
        keyPrefix: "mantis_live_abcd",
        apiKey: "mantis_live_abcdef1234567890",
        edgeWorkerUrl: "https://mantis-edge.example.workers.dev",
        edgeKey: "MGYWRl0WT3RcVuQrMQuv4Ph9DcZakhfwHcZk0lszKnE",
      },
      {
        name: "backup",
        baseUrl: "https://mantis-fallback.example.com",
        keyPrefix: "mantis_live_zzzz",
        apiKey: "mantis_live_zzzz9999",
        cloudflareAccessMode: "service-auth",
        cloudflareAccessAppUrl: "https://mantis-fallback.example.com",
        cloudflareServiceAuth: {
          client_id: "abc123.access",
          client_secret: "secret-secret",
        },
      },
    ],
    plugins: [
      {
        name: "@example/mantis-plugin-foo",
        source: "example/mantis-plugin-foo",
        ref: "abc123def4567890abc123def4567890abc12345",
        version: "0.1.0",
      },
    ],
  };
}

describe("backup bundle", () => {
  it("round-trips a payload with the correct passphrase", async () => {
    const payload = samplePayload();
    const envelope = await sealBundle(payload, "correct horse battery staple");
    expect(envelope.format).toBe("mantis-backup-v1");
    expect(envelope.encryption.cipher).toBe("AES-256-GCM");
    expect(envelope.encryption.kdf).toBe("scrypt");

    const decrypted = await openBundle(
      envelope,
      "correct horse battery staple",
    );
    expect(decrypted).toEqual(payload);
  });

  it("rejects a wrong passphrase with a clear error", async () => {
    const envelope = await sealBundle(samplePayload(), "right");
    await expect(openBundle(envelope, "wrong")).rejects.toThrow(
      /could not decrypt/i,
    );
  });

  it("rejects an envelope with the wrong format tag", async () => {
    const envelope = await sealBundle(samplePayload(), "pw");
    const tampered = { ...envelope, format: "mantis-backup-v999" };
    await expect(openBundle(tampered, "pw")).rejects.toThrow(
      /unsupported backup format/i,
    );
  });

  it("rejects an envelope with truncated ciphertext", async () => {
    const envelope = await sealBundle(samplePayload(), "pw");
    const tampered = {
      ...envelope,
      ciphertextB64: envelope.ciphertextB64.slice(0, 4),
    };
    await expect(openBundle(tampered, "pw")).rejects.toThrow(
      /could not decrypt|too short/i,
    );
  });

  it("rejects an envelope where the auth tag has been flipped", async () => {
    const envelope = await sealBundle(samplePayload(), "pw");
    // Flip the last base64 char in the ciphertext (auth tag region).
    const last = envelope.ciphertextB64.slice(-1);
    const replacement = last === "A" ? "B" : "A";
    const tampered = {
      ...envelope,
      ciphertextB64: envelope.ciphertextB64.slice(0, -1) + replacement,
    };
    await expect(openBundle(tampered, "pw")).rejects.toThrow(/could not decrypt/i);
  });

  it("produces different ciphertext for two seals of the same payload", async () => {
    // Salt + nonce are randomized; two seals should never collide.
    const a = await sealBundle(samplePayload(), "pw");
    const b = await sealBundle(samplePayload(), "pw");
    expect(a.encryption.saltB64).not.toBe(b.encryption.saltB64);
    expect(a.encryption.nonceB64).not.toBe(b.encryption.nonceB64);
    expect(a.ciphertextB64).not.toBe(b.ciphertextB64);
  });

  it("handles an empty profile list", async () => {
    const empty: BackupPayload = {
      $schema: "mantis-backup-v1",
      exportedAt: "2026-05-14T12:00:00.000Z",
      profiles: [],
      plugins: [],
    };
    const envelope = await sealBundle(empty, "pw");
    expect(await openBundle(envelope, "pw")).toEqual(empty);
  });
});

describe("backup bundle — KDF cost bounds (untrusted-input DoS guard)", () => {
  // The envelope's scrypt cost params are read straight from the (untrusted)
  // bundle and fed to scrypt BEFORE the GCM tag / passphrase can be verified.
  // A hostile bundle that inflates `p` (linear CPU, slips past `maxmem`) or
  // `N` could otherwise pin the operator's CPU for minutes-to-hours. These
  // assert the validator rejects out-of-range cost FAST, before deriveKey.

  function withKdfParams(
    envelope: Awaited<ReturnType<typeof sealBundle>>,
    kdfParams: Record<string, unknown>,
  ) {
    return {
      ...envelope,
      encryption: { ...envelope.encryption, kdfParams },
    };
  }

  it("accepts the legitimate defaults (N=32768, r=8, p=1) on round-trip", async () => {
    const envelope = await sealBundle(samplePayload(), "pw");
    expect(envelope.encryption.kdfParams).toEqual({ N: 32768, r: 8, p: 1 });
    expect(await openBundle(envelope, "pw")).toEqual(samplePayload());
  });

  it("rejects an inflated p before deriving a key", async () => {
    const base = await sealBundle(samplePayload(), "pw");
    // p=100000 would burn ~100000× the CPU of the default if it ever reached
    // scrypt. The bound must reject it essentially instantly instead.
    const hostile = withKdfParams(base, { N: 32768, r: 8, p: 100000 });

    const start = performance.now();
    await expect(openBundle(hostile, "pw")).rejects.toThrow(
      /kdfParams\.p .* out of range/i,
    );
    // Generous ceiling: a real scrypt run with p=100000 would take many
    // seconds-to-minutes. Rejecting in well under a second proves deriveKey
    // was never reached.
    expect(performance.now() - start).toBeLessThan(1000);
  });

  it("rejects an inflated N before deriving a key", async () => {
    const base = await sealBundle(samplePayload(), "pw");
    const hostile = withKdfParams(base, { N: 1 << 30, r: 8, p: 1 });
    await expect(openBundle(hostile, "pw")).rejects.toThrow(
      /kdfParams\.N .* out of range/i,
    );
  });

  it("rejects an N that isn't a power of two", async () => {
    const base = await sealBundle(samplePayload(), "pw");
    const hostile = withKdfParams(base, { N: 32768 + 1, r: 8, p: 1 });
    await expect(openBundle(hostile, "pw")).rejects.toThrow(
      /kdfParams\.N .* out of range/i,
    );
  });

  it("rejects an out-of-range r", async () => {
    const base = await sealBundle(samplePayload(), "pw");
    const hostile = withKdfParams(base, { N: 32768, r: 1024, p: 1 });
    await expect(openBundle(hostile, "pw")).rejects.toThrow(
      /kdfParams\.r .* out of range/i,
    );
  });

  it("rejects non-integer cost params", async () => {
    const base = await sealBundle(samplePayload(), "pw");
    const hostile = withKdfParams(base, { N: 32768, r: 8, p: 1.5 });
    await expect(openBundle(hostile, "pw")).rejects.toThrow(/must be integers/i);
  });

  it("still rejects entirely non-numeric cost params", async () => {
    const base = await sealBundle(samplePayload(), "pw");
    const hostile = withKdfParams(base, { N: "32768", r: 8, p: 1 });
    await expect(openBundle(hostile, "pw")).rejects.toThrow(
      /must include numeric N, r, p/i,
    );
  });

  it("accepts a higher-but-sane operator-bumped cost (N=2^16, r=8, p=4)", async () => {
    // An operator who legitimately bumps cost within bounds (and within the
    // maxmem cap: 128 * N * r ≈ 64 MiB here) must still round-trip — the
    // guard isn't a straitjacket on the defaults.
    const base = await sealBundle(samplePayload(), "pw");
    const stronger = withKdfParams(base, { N: 1 << 16, r: 8, p: 4 });
    // This envelope's ciphertext was sealed with the DEFAULT params, so it
    // won't decrypt — but it must pass the bounds check and reach deriveKey
    // (surfacing as a decrypt failure, NOT an out-of-range rejection).
    await expect(openBundle(stronger, "pw")).rejects.toThrow(
      /could not decrypt/i,
    );
  });
});
