// Encrypted backup-bundle format for `mantis backup` / `mantis restore`.
//
// What's in a bundle:
//   - one or more profiles, each with: base URL, key prefix, Cloudflare
//     Access mode/app URL, edge worker URL, and (encrypted) the full API
//     key, Cloudflare Service-Auth credentials, and edge AES key.
//   - the active-profile pointer (currentProfile)
//   - a list of installed CLI plugins as (name, source, ref) tuples so
//     `restore` can re-install them via `mantis plugin add source@ref`.
//
// The whole payload is encrypted under a key derived from a user passphrase
// (scrypt → AES-256-GCM). The outer envelope holds KDF parameters + salt +
// nonce so an arbitrarily old backup can still be decrypted by a future
// version of the CLI, even if defaults change.
//
// The envelope is plain JSON — small, diff-friendly, fine to commit to a
// private git-crypt repo or paste into a vault.

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scrypt,
  timingSafeEqual,
} from "node:crypto";
import {
  getCloudflareServiceAuth,
  getKey,
  listProfiles,
  type CloudflareServiceAuth,
  type ProfileEntry,
  type StoredConfig,
  type CloudflareAccessMode,
} from "./config.js";
import { getEdgeKey } from "./edge-key.js";
import { readLockfile } from "./plugins/lockfile.js";

// Manually promisify so we control the options-arg signature. Node's
// `scrypt` callback has an optional options object that `util.promisify`'s
// typings don't surface.
function scryptAsync(
  passphrase: string,
  salt: Buffer,
  keyLen: number,
  options: { N: number; r: number; p: number; maxmem: number },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(passphrase, salt, keyLen, options, (err, derived) => {
      if (err) reject(err);
      else resolve(derived as Buffer);
    });
  });
}

const FORMAT_TAG = "mantis-backup-v1";
const KEY_LEN = 32; // AES-256
const SALT_LEN = 16;
const NONCE_LEN = 12; // GCM standard

/**
 * scrypt cost. N=32768 / r=8 / p=1 is roughly OWASP-recommended for
 * interactive-password use cases and fits comfortably in 64 MiB. Tuning
 * these is fine; they live in the envelope so older backups still decrypt.
 */
const DEFAULT_KDF_PARAMS = {
  N: 32768,
  r: 8,
  p: 1,
} as const;

// ---------------------------------------------------------------------------
// Payload — the cleartext shape inside the encrypted envelope
// ---------------------------------------------------------------------------

export type BackupProfile = {
  name: string;
  baseUrl: string;
  keyPrefix?: string;
  apiKey: string;
  cloudflareAccessAppUrl?: string;
  cloudflareAccessMode?: CloudflareAccessMode;
  cloudflareServiceAuth?: CloudflareServiceAuth;
  edgeWorkerUrl?: string;
  edgeKey?: string;
};

export type BackupPlugin = {
  name: string;
  source: string;
  /** Resolved 40-char commit SHA (or empty for local installs / unknown). */
  ref: string;
  version: string;
};

export type BackupPayload = {
  $schema: typeof FORMAT_TAG;
  exportedAt: string;
  currentProfile?: string;
  profiles: BackupProfile[];
  plugins: BackupPlugin[];
};

// ---------------------------------------------------------------------------
// Envelope — the encrypted outer JSON
// ---------------------------------------------------------------------------

export type BackupEnvelope = {
  format: typeof FORMAT_TAG;
  createdAt: string;
  encryption: {
    cipher: "AES-256-GCM";
    kdf: "scrypt";
    kdfParams: { N: number; r: number; p: number };
    saltB64: string;
    nonceB64: string;
  };
  /** Base64-encoded ciphertext concatenated with the 16-byte GCM auth tag. */
  ciphertextB64: string;
};

// ---------------------------------------------------------------------------
// Collect / restore secrets — bridge between config/keychain and bundle
// ---------------------------------------------------------------------------

/**
 * Read the on-disk profile list + matching keychain entries into a single
 * in-memory payload, ready to encrypt. When `onlyProfile` is set, includes
 * only that one profile; otherwise every stored profile.
 */
export async function collectBackupPayload(
  onlyProfile: string | undefined,
): Promise<BackupPayload> {
  const { current, profiles } = await listProfiles();

  const filtered =
    onlyProfile === undefined
      ? profiles
      : profiles.filter((p) => p.name === onlyProfile);
  if (onlyProfile !== undefined && filtered.length === 0) {
    throw new Error(
      `profile '${onlyProfile}' not found. Run \`mantis profile list\` to see configured profiles.`,
    );
  }

  const backupProfiles: BackupProfile[] = [];
  const missing: string[] = [];

  for (const { name, entry } of filtered) {
    const apiKey = getKey(entry.baseUrl);
    if (!apiKey) {
      missing.push(name);
      continue;
    }
    const cfServiceAuth =
      entry.cloudflareAccessMode === "service-auth"
        ? getCloudflareServiceAuth(entry.baseUrl) ?? undefined
        : undefined;
    const edgeKey = entry.edgeWorkerUrl
      ? getEdgeKey(entry.edgeWorkerUrl) ?? undefined
      : undefined;

    backupProfiles.push({
      name,
      baseUrl: entry.baseUrl,
      keyPrefix: entry.keyPrefix,
      apiKey,
      cloudflareAccessAppUrl: entry.cloudflareAccessAppUrl,
      cloudflareAccessMode: entry.cloudflareAccessMode,
      cloudflareServiceAuth: cfServiceAuth,
      edgeWorkerUrl: entry.edgeWorkerUrl,
      edgeKey,
    });
  }

  if (missing.length > 0) {
    throw new Error(
      `cannot back up — these profiles have no API key in the OS keychain (run \`mantis login --profile <name>\` to populate it): ${missing.join(", ")}`,
    );
  }

  const lock = await readLockfile();
  const plugins: BackupPlugin[] = lock.plugins
    // Local-path plugins aren't reproducible on another machine — skip them
    // and let the caller print a warning.
    .filter((p) => !p.source.startsWith("/") && !p.source.startsWith("."))
    .map((p) => ({
      name: p.name,
      source: p.source,
      ref: p.resolvedSha,
      version: p.version,
    }));

  return {
    $schema: FORMAT_TAG,
    exportedAt: new Date().toISOString(),
    currentProfile:
      onlyProfile === undefined ? current ?? undefined : onlyProfile,
    profiles: backupProfiles,
    plugins,
  };
}

/**
 * Names of plugins in the on-disk lockfile that we skipped because they
 * came from a local path. Caller can warn the user.
 */
export async function collectSkippedLocalPlugins(): Promise<string[]> {
  const lock = await readLockfile();
  return lock.plugins
    .filter((p) => p.source.startsWith("/") || p.source.startsWith("."))
    .map((p) => p.name);
}

/**
 * Convert a BackupProfile back into a (ProfileEntry, secrets) pair so the
 * restore command can write the config + populate the keychain.
 */
export function profileEntryFromBackup(
  bp: BackupProfile,
): { entry: ProfileEntry; secrets: { apiKey: string; cf?: CloudflareServiceAuth; edgeKey?: string } } {
  return {
    entry: {
      baseUrl: bp.baseUrl,
      keyPrefix: bp.keyPrefix,
      cloudflareAccessAppUrl: bp.cloudflareAccessAppUrl,
      cloudflareAccessMode: bp.cloudflareAccessMode,
      edgeWorkerUrl: bp.edgeWorkerUrl,
    },
    secrets: {
      apiKey: bp.apiKey,
      cf: bp.cloudflareServiceAuth,
      edgeKey: bp.edgeKey,
    },
  };
}

// ---------------------------------------------------------------------------
// Crypto: passphrase → key, then AES-256-GCM seal / open
// ---------------------------------------------------------------------------

async function deriveKey(
  passphrase: string,
  salt: Buffer,
  params: { N: number; r: number; p: number },
): Promise<Buffer> {
  // maxmem must accommodate N * r * 128 bytes plus overhead. 128 MiB is
  // generous for the defaults and still scales for users who bump cost.
  return scryptAsync(passphrase, salt, KEY_LEN, {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: 128 * 1024 * 1024,
  });
}

export async function sealBundle(
  payload: BackupPayload,
  passphrase: string,
): Promise<BackupEnvelope> {
  const salt = randomBytes(SALT_LEN);
  const nonce = randomBytes(NONCE_LEN);
  const params = { ...DEFAULT_KDF_PARAMS };
  const key = await deriveKey(passphrase, salt, params);

  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(payload), "utf8")),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag(); // 16 bytes

  return {
    format: FORMAT_TAG,
    createdAt: new Date().toISOString(),
    encryption: {
      cipher: "AES-256-GCM",
      kdf: "scrypt",
      kdfParams: params,
      saltB64: salt.toString("base64"),
      nonceB64: nonce.toString("base64"),
    },
    ciphertextB64: Buffer.concat([ciphertext, authTag]).toString("base64"),
  };
}

export async function openBundle(
  envelope: unknown,
  passphrase: string,
): Promise<BackupPayload> {
  const env = assertEnvelope(envelope);

  const salt = Buffer.from(env.encryption.saltB64, "base64");
  const nonce = Buffer.from(env.encryption.nonceB64, "base64");
  const combined = Buffer.from(env.ciphertextB64, "base64");
  if (combined.length < 16) {
    throw new Error("bundle ciphertext is too short to contain a GCM tag");
  }
  const tag = combined.subarray(combined.length - 16);
  const ciphertext = combined.subarray(0, combined.length - 16);

  const key = await deriveKey(passphrase, salt, env.encryption.kdfParams);

  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAuthTag(tag);

  let plaintext: Buffer;
  try {
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    // GCM auth failure. Most often: wrong passphrase. Could also be a
    // tampered bundle — we can't distinguish, so give the user the more
    // likely cause first.
    throw new Error(
      "could not decrypt the bundle. Wrong passphrase, or the file is corrupted / not a mantis backup.",
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext.toString("utf8"));
  } catch {
    throw new Error(
      "bundle decrypted but the inner JSON is malformed. The file may be from an incompatible mantis version.",
    );
  }
  return assertPayload(parsed);
}

// ---------------------------------------------------------------------------
// Shape checks. Hand-rolled so the CLI doesn't depend on a schema lib for
// one file. Errors point at what's wrong so a user can spot a hand-edited
// or corrupted bundle without grepping types.
// ---------------------------------------------------------------------------

function assertEnvelope(v: unknown): BackupEnvelope {
  const o = requireObject(v, "envelope");
  if (o.format !== FORMAT_TAG) {
    throw new Error(
      `unsupported backup format: ${String(o.format)}. Expected ${FORMAT_TAG}. This CLI may be older than the file.`,
    );
  }
  const enc = requireObject(o.encryption, "envelope.encryption");
  if (enc.cipher !== "AES-256-GCM") {
    throw new Error(
      `unsupported cipher: ${String(enc.cipher)}. This CLI only understands AES-256-GCM.`,
    );
  }
  if (enc.kdf !== "scrypt") {
    throw new Error(
      `unsupported KDF: ${String(enc.kdf)}. This CLI only understands scrypt.`,
    );
  }
  const params = requireObject(enc.kdfParams, "envelope.encryption.kdfParams");
  if (
    typeof params.N !== "number" ||
    typeof params.r !== "number" ||
    typeof params.p !== "number"
  ) {
    throw new Error("envelope.encryption.kdfParams must include numeric N, r, p");
  }
  if (typeof enc.saltB64 !== "string" || typeof enc.nonceB64 !== "string") {
    throw new Error("envelope.encryption.{saltB64,nonceB64} must be strings");
  }
  if (typeof o.ciphertextB64 !== "string") {
    throw new Error("envelope.ciphertextB64 must be a string");
  }
  return o as unknown as BackupEnvelope;
}

function assertPayload(v: unknown): BackupPayload {
  const o = requireObject(v, "payload");
  if (o.$schema !== FORMAT_TAG) {
    throw new Error(
      `payload schema mismatch: ${String(o.$schema)} (expected ${FORMAT_TAG})`,
    );
  }
  if (!Array.isArray(o.profiles)) {
    throw new Error("payload.profiles must be an array");
  }
  if (!Array.isArray(o.plugins)) {
    throw new Error("payload.plugins must be an array");
  }
  return o as unknown as BackupPayload;
}

function requireObject(v: unknown, label: string): Record<string, unknown> {
  if (typeof v !== "object" || v === null) {
    throw new Error(`${label} must be an object`);
  }
  return v as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Convenience helpers used by the command + tests
// ---------------------------------------------------------------------------

/** Constant-time string compare so passphrase-confirmation can't be timed. */
export function safeEqualString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

/** Used by tests; lets us round-trip without writing to disk. */
export type StoredConfigFromBackup = StoredConfig;
