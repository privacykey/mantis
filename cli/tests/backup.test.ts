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
