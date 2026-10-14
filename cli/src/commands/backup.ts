import { access, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join, resolve as resolvePath } from "node:path";
import { createInterface } from "node:readline/promises";
import {
  getCloudflareServiceAuth,
  getKey,
  getProfile,
  setCloudflareServiceAuth,
  setKey,
  setProfile,
  useProfile,
} from "../lib/config.js";
import { getEdgeKey, setEdgeKey } from "../lib/edge-key.js";
import {
  collectBackupPayload,
  collectSkippedLocalPlugins,
  openBundle,
  profileEntryFromBackup,
  safeEqualString,
  sealBundle,
  type BackupPlugin,
  type BackupProfile,
} from "../lib/backup.js";
import { c, emit, fail, isJsonMode, safeText } from "../lib/out.js";
import { pluginAddCmd } from "./plugin.js";

export type BackupCmdOpts = {
  out?: string;
  profile?: string;
  passphraseStdin?: boolean;
  passphraseEnv?: string;
};

export type RestoreCmdOpts = {
  overwrite?: boolean;
  passphraseStdin?: boolean;
  passphraseEnv?: string;
  /** When true, skip plugin re-install (faster restore; user can re-run later). */
  skipPlugins?: boolean;
};

// ---------------------------------------------------------------------------
// backup
// ---------------------------------------------------------------------------

export async function backupCmd(opts: BackupCmdOpts): Promise<void> {
  const outPath = resolvePath(opts.out ?? "./mantis-backup.json");

  // Collect first, so we fail before prompting for a passphrase if a profile
  // is missing its keychain entry.
  const payload = await collectBackupPayload(opts.profile);
  const skippedLocalPlugins = await collectSkippedLocalPlugins();

  const passphrase = await readPassphrase({
    confirm: true,
    fromStdin: opts.passphraseStdin,
    fromEnv: opts.passphraseEnv,
    label: "Backup passphrase",
  });

  const envelope = await sealBundle(payload, passphrase);
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(envelope, null, 2) + "\n", {
    encoding: "utf8",
    mode: 0o600,
  });
  // The default path is ./mantis-backup.json, so running this inside a
  // checkout drops a credential bundle one `git add .` away from a commit.
  const gitRoot = await gitWorkTreeOf(outPath);

  emit(
    () => {
      process.stderr.write(
        `${c.green("✓")} wrote encrypted backup to ${c.cyan(outPath)}\n`,
      );
      process.stderr.write(
        `  ${c.dim("profiles:")} ${payload.profiles.map((p) => p.name).join(", ")}\n`,
      );
      process.stderr.write(
        `  ${c.dim("plugins: ")} ${payload.plugins.length === 0 ? c.dim("(none)") : payload.plugins.map((p) => p.name).join(", ")}\n`,
      );
      process.stderr.write(
        `  ${c.dim("edge workers:")} ${payload.edgeWorkers?.map((worker) => worker.workerUrl).join(", ") || c.dim("(none)")}\n`,
      );
      if (opts.profile) {
        process.stderr.write(`  ${c.dim("scope:")} only profile ${opts.profile} and its linked worker; omit --only to include independent edge workers.\n`);
      }
      if (skippedLocalPlugins.length > 0) {
        process.stderr.write(
          `  ${c.yellow("note:")} skipped ${skippedLocalPlugins.length} local-path plugin(s) (not reproducible on another machine): ${skippedLocalPlugins.join(", ")}\n`,
        );
      }
      process.stderr.write(
        `  ${c.dim("encrypted:")} scrypt + AES-256-GCM. Lose the passphrase and the contents are unrecoverable.\n`,
      );
      process.stderr.write(
        `  ${c.dim("keep it private:")} the bundle holds full API keys and the passphrase is its only protection — anyone who gets the file can try passphrases offline, without limit. Store it in a vault or a private, access-controlled repository; never in a public or widely shared one.\n`,
      );
    },
    {
      out: outPath,
      in_git_work_tree: gitRoot,
      profiles: payload.profiles.map((p) => p.name),
      plugins: payload.plugins.length,
      skipped_local_plugins: skippedLocalPlugins,
      edge_workers: payload.edgeWorkers?.map((worker) => worker.workerUrl) ?? [],
      scope: opts.profile ?? "all",
    },
  );
  // Outside emit() so --quiet doesn't swallow it; --json carries the same
  // fact as in_git_work_tree.
  if (gitRoot && !isJsonMode()) {
    process.stderr.write(
      `${c.yellow("warning:")} ${outPath} is inside a git work tree (${gitRoot}). Add it to .gitignore or move it out before your next commit, unless that repository is private and meant to hold credentials.\n`,
    );
  }
}

/**
 * The git work tree a path sits in, or null. Found by walking up for a `.git`
 * entry (a directory, or the file a worktree / submodule has) — no git binary
 * involved, and symlinks are resolved first so a linked directory counts.
 */
async function gitWorkTreeOf(path: string): Promise<string | null> {
  let dir = await realpath(dirname(path)).catch(() => dirname(path));
  for (;;) {
    if (await access(join(dir, ".git")).then(() => true, () => false)) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// ---------------------------------------------------------------------------
// restore
// ---------------------------------------------------------------------------

export async function restoreCmd(
  file: string | undefined,
  opts: RestoreCmdOpts,
): Promise<void> {
  if (!file) {
    fail(
      "path to a backup file is required (e.g. `mantis restore ./mantis-backup.json`)",
    );
  }
  const filePath = resolvePath(file);
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      fail(`backup file not found: ${filePath}`);
    }
    throw err;
  }
  let envelope: unknown;
  try {
    envelope = JSON.parse(raw);
  } catch {
    fail(
      `${filePath} is not valid JSON. Make sure you're pointing at the file \`mantis backup\` produced, not the cleartext payload.`,
    );
  }

  const passphrase = await readPassphrase({
    confirm: false,
    fromStdin: opts.passphraseStdin,
    fromEnv: opts.passphraseEnv,
    label: "Restore passphrase",
  });

  let payload;
  try {
    payload = await openBundle(envelope, passphrase);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }

  const restored: string[] = [];
  const skipped: string[] = [];
  // Subset of `skipped`: new profile names whose server already has different
  // credentials stored here.
  const skippedCredentials: string[] = [];
  const errors: Array<{ name: string; reason: string }> = [];

  // The API key and Cloudflare Service-Auth keychain items are keyed by server
  // URL, not profile name, and every profile for that URL shares them. So the
  // "keep what exists unless --overwrite" rule has to hold for the credential
  // as well as the name — same as the edge keys below — or a bundle profile
  // with a new name would silently swap the key under an existing profile.
  const writtenBaseUrls = new Set<string>();
  for (const bp of payload.profiles) {
    const existing = await getProfile(bp.name);
    if (existing && !opts.overwrite) {
      skipped.push(bp.name);
      continue;
    }
    if (
      !opts.overwrite &&
      !writtenBaseUrls.has(bp.baseUrl) &&
      wouldReplaceStoredCredentials(bp)
    ) {
      skipped.push(bp.name);
      skippedCredentials.push(bp.name);
      continue;
    }
    try {
      await applyProfile(bp);
      writtenBaseUrls.add(bp.baseUrl);
      restored.push(bp.name);
    } catch (err) {
      errors.push({
        name: bp.name,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const edgeRestored: string[] = [];
  const edgeSkipped: string[] = [];
  const edgeErrors: Array<{ worker: string; reason: string }> = [];
  // Legacy v1 files embedded keys in profiles. Apply the same protection to
  // those keys as independent worker entries, even when the profile is new.
  const workerKeys = new Map<string, string>();
  for (const profile of payload.profiles) {
    if (profile.edgeWorkerUrl && profile.edgeKey) workerKeys.set(profile.edgeWorkerUrl, profile.edgeKey);
  }
  for (const { workerUrl, key } of payload.edgeWorkers ?? []) workerKeys.set(workerUrl, key);
  for (const [workerUrl, key] of workerKeys) {
    if (getEdgeKey(workerUrl) && !opts.overwrite) {
      edgeSkipped.push(workerUrl);
      continue;
    }
    try {
      setEdgeKey(workerUrl, key);
      edgeRestored.push(workerUrl);
    } catch (err) {
      edgeErrors.push({ worker: workerUrl, reason: err instanceof Error ? err.message : String(err) });
    }
  }

  // Restore active-profile pointer if the backup specified one AND we
  // actually restored it AND the user didn't already have a different
  // current profile they care about.
  if (payload.currentProfile && restored.includes(payload.currentProfile)) {
    await useProfile(payload.currentProfile);
  }

  // Plugins: best-effort. A missing repo / network failure shouldn't tank
  // the whole restore — we collect errors and report.
  const pluginsRestored: string[] = [];
  const pluginsFailed: Array<{ name: string; reason: string }> = [];
  if (!opts.skipPlugins) {
    for (const p of payload.plugins) {
      const spec = pluginSpec(p);
      try {
        await pluginAddCmd(spec);
        pluginsRestored.push(p.name);
      } catch (err) {
        pluginsFailed.push({
          name: p.name,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  // Names, URLs and plugin specs below come out of the bundle, which may have
  // been written on another machine or by someone else.
  const list = (items: string[]) => items.map(safeText).join(", ");
  emit(
    () => {
      if (restored.length > 0) {
        process.stderr.write(
          `${c.green("✓")} restored ${restored.length} profile(s): ${list(restored)}\n`,
        );
      }
      const skippedByName = skipped.filter((n) => !skippedCredentials.includes(n));
      if (skippedByName.length > 0) {
        process.stderr.write(
          `${c.yellow("·")} skipped ${skippedByName.length} existing profile(s) (pass --overwrite to replace): ${list(skippedByName)}\n`,
        );
      }
      if (skippedCredentials.length > 0) {
        process.stderr.write(
          `${c.yellow("·")} skipped ${skippedCredentials.length} profile(s) whose server already has different credentials stored on this machine: ${list(skippedCredentials)}\n` +
            `  ${c.dim("those credentials are shared by every profile for that server; pass --overwrite to replace them with the bundle's.")}\n`,
        );
      }
      for (const e of errors) {
        process.stderr.write(
          `${c.red("✗")} ${safeText(e.name)}: ${safeText(e.reason)}\n`,
        );
      }
      if (edgeRestored.length > 0) process.stderr.write(`${c.green("✓")} restored edge keys: ${list(edgeRestored)}\n`);
      if (edgeSkipped.length > 0) process.stderr.write(`${c.yellow("·")} kept existing edge keys (pass --overwrite to replace): ${list(edgeSkipped)}\n`);
      for (const e of edgeErrors) process.stderr.write(`${c.red("✗")} edge ${safeText(e.worker)}: ${safeText(e.reason)}\n`);
      if (!opts.skipPlugins) {
        if (pluginsRestored.length > 0) {
          process.stderr.write(
            `${c.green("✓")} restored ${pluginsRestored.length} plugin(s): ${list(pluginsRestored)}\n`,
          );
        }
        for (const f of pluginsFailed) {
          process.stderr.write(
            `${c.red("✗")} plugin ${safeText(f.name)} (${safeText(pluginSpec(payload.plugins.find((x) => x.name === f.name)!))}): ${safeText(f.reason)}\n`,
          );
        }
      } else if (payload.plugins.length > 0) {
        process.stderr.write(
          `${c.dim("·")} skipped ${payload.plugins.length} plugin(s) (--skip-plugins); re-install with \`mantis plugin add <source>\` later.\n`,
        );
      }
      if (
        payload.currentProfile &&
        restored.includes(payload.currentProfile)
      ) {
        process.stderr.write(
          `  ${c.dim("active profile:")} ${c.bold(safeText(payload.currentProfile))}\n`,
        );
      }
    },
    {
      restored,
      skipped,
      skipped_credentials: skippedCredentials,
      errors,
      plugins_restored: pluginsRestored,
      plugins_failed: pluginsFailed,
      active_profile: payload.currentProfile,
      edge_restored: edgeRestored,
      edge_skipped: edgeSkipped,
      edge_errors: edgeErrors,
    },
  );
  if (errors.length || edgeErrors.length || pluginsFailed.length) process.exitCode = 1;
}

async function applyProfile(bp: BackupProfile): Promise<void> {
  const { entry, secrets } = profileEntryFromBackup(bp);
  // Write keychain entries BEFORE the config so a partial failure leaves
  // the most-recent state (the config file is the authoritative "we know
  // about this profile" marker).
  setKey(entry.baseUrl, secrets.apiKey);
  if (secrets.cf) setCloudflareServiceAuth(entry.baseUrl, secrets.cf);
  await setProfile(bp.name, entry);
}

/**
 * Would applying this bundle profile change a credential already stored for
 * its server? A stored value identical to the bundle's is not a change, so a
 * bundle profile that only adds another name for a server whose key is
 * already here still restores.
 */
function wouldReplaceStoredCredentials(bp: BackupProfile): boolean {
  const storedKey = getKey(bp.baseUrl);
  if (storedKey && storedKey !== bp.apiKey) return true;
  const cf = bp.cloudflareServiceAuth;
  if (cf) {
    const storedCf = getCloudflareServiceAuth(bp.baseUrl);
    if (
      storedCf &&
      (storedCf.client_id !== cf.client_id ||
        storedCf.client_secret !== cf.client_secret)
    ) {
      return true;
    }
  }
  return false;
}

function pluginSpec(p: BackupPlugin): string {
  // Re-install at the same pinned commit when we have one; otherwise let
  // the plugin installer resolve to the source's default branch.
  return p.ref ? `${p.source}@${p.ref}` : p.source;
}

// ---------------------------------------------------------------------------
// Passphrase input — prompt, stdin, or env var. Inline `--passphrase <v>`
// is deliberately not offered (shell history leak).
// ---------------------------------------------------------------------------

async function readPassphrase(opts: {
  confirm: boolean;
  fromStdin?: boolean;
  fromEnv?: string;
  label: string;
}): Promise<string> {
  if (opts.fromEnv) {
    const v = process.env[opts.fromEnv];
    if (!v || v.length === 0) {
      fail(
        `${opts.label}: env var ${opts.fromEnv} is unset or empty. Set it before running, or omit --passphrase-env to prompt.`,
      );
    }
    return v;
  }
  if (opts.fromStdin) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    }
    const raw = Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
    if (!raw) {
      fail(`${opts.label}: stdin was empty`);
    }
    return raw;
  }

  if (isJsonMode()) {
    fail(
      `${opts.label}: cannot prompt in --json mode. Use --passphrase-stdin or --passphrase-env <var>.`,
    );
  }
  if (!process.stdin.isTTY) {
    fail(
      `${opts.label}: stdin is not a TTY and no --passphrase-stdin / --passphrase-env was given. Pass one of those, or run interactively.`,
    );
  }

  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    // Note: this echoes input. Node's readline doesn't have native silent
    // mode without bringing in a dependency. The passphrase is for an
    // encrypted file, not for live auth, so echo-on-screen is a tolerable
    // trade-off and matches `mantis edge set-key`'s paste prompt.
    const first = (await rl.question(`${opts.label}: `)).trim();
    if (!first) fail(`${opts.label} cannot be empty`);
    if (!opts.confirm) return first;

    const second = (await rl.question(`${opts.label} (confirm): `)).trim();
    if (!safeEqualString(first, second)) {
      fail("passphrases did not match — aborting without writing the bundle.");
    }
    return first;
  } finally {
    rl.close();
  }
}
