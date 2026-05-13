import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// plugins.lock.json is informational. The authoritative source for what
// runs is whatever's in plugins/<name>/ on disk. No integrity guarantees
// against an attacker with write access to ~/.config/mantis (out of scope).

const CONFIG_DIR = join(
  process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
  "mantis",
);
const LOCKFILE = join(CONFIG_DIR, "plugins.lock.json");

export const PLUGIN_CONFIG_DIR = CONFIG_DIR;
export const PLUGIN_INSTALL_DIR = join(CONFIG_DIR, "plugins");

export type LockEntry = {
  /** From the manifest; also the install dir name. */
  name: string;
  /** Ref the operator requested (branch/tag/sha); empty for local installs. */
  requestedRef: string;
  /** Resolved 40-char commit SHA; empty for local installs. */
  resolvedSha: string;
  /** `owner/repo` or absolute local path. */
  source: string;
  version: string;
  /** ISO timestamp. */
  installedAt: string;
};

export type Lockfile = {
  $schema: "mantis-plugins-lock.v1";
  plugins: LockEntry[];
};

const EMPTY_LOCK: Lockfile = {
  $schema: "mantis-plugins-lock.v1",
  plugins: [],
};

export async function readLockfile(): Promise<Lockfile> {
  try {
    const raw = await readFile(LOCKFILE, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      Array.isArray((parsed as Lockfile).plugins)
    ) {
      return parsed as Lockfile;
    }
    return { ...EMPTY_LOCK };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { ...EMPTY_LOCK };
    }
    throw err;
  }
}

export async function writeLockfile(lock: Lockfile): Promise<void> {
  await mkdir(dirname(LOCKFILE), { recursive: true });
  await writeFile(LOCKFILE, JSON.stringify(lock, null, 2) + "\n", {
    mode: 0o600,
  });
}

export async function upsertLockEntry(entry: LockEntry): Promise<void> {
  const lock = await readLockfile();
  lock.plugins = lock.plugins.filter((p) => p.name !== entry.name);
  lock.plugins.push(entry);
  lock.plugins.sort((a, b) => a.name.localeCompare(b.name));
  await writeLockfile(lock);
}

export async function removeLockEntry(name: string): Promise<boolean> {
  const lock = await readLockfile();
  const before = lock.plugins.length;
  lock.plugins = lock.plugins.filter((p) => p.name !== name);
  if (lock.plugins.length === before) return false;
  await writeLockfile(lock);
  return true;
}

export async function findLockEntry(name: string): Promise<LockEntry | null> {
  const lock = await readLockfile();
  return lock.plugins.find((p) => p.name === name) ?? null;
}

export function pluginDir(name: string): string {
  return join(PLUGIN_INSTALL_DIR, name);
}
