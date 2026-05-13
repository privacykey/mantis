import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Entry } from "@napi-rs/keyring";

const CONFIG_DIR = join(
  process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
  "mantis",
);
const CONFIG_FILE = join(CONFIG_DIR, "config.json");
const KEYCHAIN_SERVICE = "mantis-cli";
const KEYCHAIN_SERVICE_CF = "mantis-cli-cf";

export type CloudflareAccessMode = "sso" | "service-auth";

export type ProfileEntry = {
  baseUrl: string;
  keyPrefix?: string;
  /** URL of the Cloudflare Access application gating this mantis (e.g. https://mantis.example.com). */
  cloudflareAccessAppUrl?: string;
  /** How the CLI gets a credential past Cloudflare Access. */
  cloudflareAccessMode?: CloudflareAccessMode;
  /** Default mantis-edge worker URL for `mantis edge mint` calls under this profile. */
  edgeWorkerUrl?: string;
};

export type StoredConfig = {
  currentProfile: string;
  profiles: Record<string, ProfileEntry>;
};

export const DEFAULT_PROFILE = "default";

function isProfileShape(v: unknown): v is StoredConfig {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.currentProfile === "string" &&
    typeof o.profiles === "object" &&
    o.profiles !== null
  );
}

function isLegacyShape(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null) return false;
  return typeof (v as Record<string, unknown>).baseUrl === "string";
}

export async function readConfig(): Promise<StoredConfig | null> {
  try {
    const raw = await readFile(CONFIG_FILE, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (isProfileShape(parsed)) return parsed;
    if (isLegacyShape(parsed)) {
      const o = parsed as {
        baseUrl: string;
        keyPrefix?: string;
        cloudflareAccessAppUrl?: string;
        cloudflareAccessMode?: CloudflareAccessMode;
      };
      const migrated: StoredConfig = {
        currentProfile: DEFAULT_PROFILE,
        profiles: {
          [DEFAULT_PROFILE]: {
            baseUrl: o.baseUrl,
            keyPrefix: o.keyPrefix,
            cloudflareAccessAppUrl: o.cloudflareAccessAppUrl,
            cloudflareAccessMode: o.cloudflareAccessMode,
          },
        },
      };
      await writeConfig(migrated);
      return migrated;
    }
    return null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export async function writeConfig(cfg: StoredConfig): Promise<void> {
  await mkdir(dirname(CONFIG_FILE), { recursive: true });
  await writeFile(CONFIG_FILE, JSON.stringify(cfg, null, 2) + "\n", {
    mode: 0o600,
  });
}

export async function clearConfig(): Promise<void> {
  try {
    await rm(CONFIG_FILE);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

export function getKey(baseUrl: string): string | null {
  try {
    return new Entry(KEYCHAIN_SERVICE, baseUrl).getPassword();
  } catch {
    return null;
  }
}

export function setKey(baseUrl: string, key: string): void {
  new Entry(KEYCHAIN_SERVICE, baseUrl).setPassword(key);
}

export function deleteKey(baseUrl: string): void {
  try {
    new Entry(KEYCHAIN_SERVICE, baseUrl).deletePassword();
  } catch {
    /* nonexistent entries throw on some platforms; ignore */
  }
}

export type CloudflareServiceAuth = {
  client_id: string;
  client_secret: string;
};

export function getCloudflareServiceAuth(
  baseUrl: string,
): CloudflareServiceAuth | null {
  try {
    const raw = new Entry(KEYCHAIN_SERVICE_CF, baseUrl).getPassword();
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CloudflareServiceAuth;
    if (
      typeof parsed?.client_id !== "string" ||
      typeof parsed?.client_secret !== "string"
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function setCloudflareServiceAuth(
  baseUrl: string,
  creds: CloudflareServiceAuth,
): void {
  new Entry(KEYCHAIN_SERVICE_CF, baseUrl).setPassword(JSON.stringify(creds));
}

export function deleteCloudflareServiceAuth(baseUrl: string): void {
  try {
    new Entry(KEYCHAIN_SERVICE_CF, baseUrl).deletePassword();
  } catch {
    /* ignore */
  }
}

export type ResolvedCloudflareAuth =
  | { mode: "sso"; appUrl: string }
  | { mode: "service-auth"; clientId: string; clientSecret: string };

export type ResolvedAuth = {
  baseUrl: string;
  key: string;
  profile?: string;
  cloudflare?: ResolvedCloudflareAuth;
};

export class AuthError extends Error {}

/**
 * Profile-resolution order:
 *   1. opts.baseUrl override (ad-hoc; no profile lookup)
 *   2. opts.profile (explicit --profile flag)
 *   3. MANTIS_PROFILE env var
 *   4. stored currentProfile
 */
function resolveProfileName(
  opts: { profile?: string },
  stored: StoredConfig | null,
): string | undefined {
  return (
    opts.profile ?? process.env.MANTIS_PROFILE ?? stored?.currentProfile
  );
}

export async function resolveAuth(opts: {
  baseUrl?: string;
  key?: string;
  profile?: string;
}): Promise<ResolvedAuth> {
  const stored = await readConfig();

  let baseUrl: string | undefined;
  let profileName: string | undefined;
  let profileEntry: ProfileEntry | undefined;

  if (opts.baseUrl) {
    baseUrl = opts.baseUrl.replace(/\/$/, "");
  } else {
    profileName = resolveProfileName(opts, stored);
    if (!profileName) {
      throw new AuthError(
        "no profile configured. Run `mantis login` or pass --base-url / --profile",
      );
    }
    const found = stored?.profiles[profileName];
    if (!found) {
      throw new AuthError(
        `profile '${profileName}' not found. Run \`mantis login --profile ${profileName}\` or \`mantis profile list\``,
      );
    }
    profileEntry = found;
    baseUrl = found.baseUrl;
  }

  const key = opts.key ?? getKey(baseUrl);
  if (!key) {
    throw new AuthError(
      `no API key for ${baseUrl}. Run \`mantis login${profileName ? ` --profile ${profileName}` : ""}\` or pass --key`,
    );
  }

  let cloudflare: ResolvedCloudflareAuth | undefined;
  if (profileEntry?.cloudflareAccessMode === "service-auth") {
    const sa = getCloudflareServiceAuth(baseUrl);
    if (sa) {
      cloudflare = {
        mode: "service-auth",
        clientId: sa.client_id,
        clientSecret: sa.client_secret,
      };
    }
  } else if (
    profileEntry?.cloudflareAccessMode === "sso" &&
    profileEntry.cloudflareAccessAppUrl
  ) {
    cloudflare = { mode: "sso", appUrl: profileEntry.cloudflareAccessAppUrl };
  }

  return { baseUrl, key, profile: profileName, cloudflare };
}

/** Returns the profile name selected by env/current — used by login / profile / edge commands. */
export async function getCurrentProfileName(
  override?: string,
): Promise<string | undefined> {
  const stored = await readConfig();
  return resolveProfileName({ profile: override }, stored);
}

export async function listProfiles(): Promise<{
  current: string | null;
  profiles: Array<{ name: string; entry: ProfileEntry }>;
}> {
  const stored = await readConfig();
  if (!stored) return { current: null, profiles: [] };
  return {
    current: stored.currentProfile,
    profiles: Object.entries(stored.profiles).map(([name, entry]) => ({
      name,
      entry,
    })),
  };
}

export async function getProfile(name: string): Promise<ProfileEntry | null> {
  const stored = await readConfig();
  return stored?.profiles[name] ?? null;
}

export async function setProfile(
  name: string,
  entry: ProfileEntry,
): Promise<void> {
  const stored = (await readConfig()) ?? {
    currentProfile: name,
    profiles: {},
  };
  stored.profiles[name] = entry;
  if (!stored.currentProfile || !stored.profiles[stored.currentProfile]) {
    stored.currentProfile = name;
  }
  await writeConfig(stored);
}

export async function patchProfile(
  name: string,
  patch: Partial<ProfileEntry>,
): Promise<ProfileEntry> {
  const stored = await readConfig();
  if (!stored || !stored.profiles[name]) {
    throw new AuthError(`profile '${name}' not found`);
  }
  const merged = { ...stored.profiles[name], ...patch };
  stored.profiles[name] = merged;
  await writeConfig(stored);
  return merged;
}

export async function removeProfile(name: string): Promise<{
  removed: boolean;
  baseUrl?: string;
  wasCurrent: boolean;
  newCurrent?: string;
}> {
  const stored = await readConfig();
  if (!stored || !stored.profiles[name]) {
    return { removed: false, wasCurrent: false };
  }
  const removed = stored.profiles[name];
  delete stored.profiles[name];
  const wasCurrent = stored.currentProfile === name;
  let newCurrent: string | undefined;
  if (wasCurrent) {
    const remaining = Object.keys(stored.profiles);
    if (remaining.length > 0) {
      stored.currentProfile = remaining[0]!;
      newCurrent = stored.currentProfile;
    } else {
      // No profiles left — drop config entirely
      await clearConfig();
      return { removed: true, baseUrl: removed.baseUrl, wasCurrent };
    }
  }
  await writeConfig(stored);
  return { removed: true, baseUrl: removed.baseUrl, wasCurrent, newCurrent };
}

export async function useProfile(name: string): Promise<void> {
  const stored = await readConfig();
  if (!stored || !stored.profiles[name]) {
    throw new AuthError(`profile '${name}' not found`);
  }
  stored.currentProfile = name;
  await writeConfig(stored);
}
