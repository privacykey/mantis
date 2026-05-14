import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve as resolvePath } from "node:path";
import { createInterface } from "node:readline/promises";
import {
  getProfile,
  setCloudflareServiceAuth,
  setKey,
  setProfile,
  useProfile,
} from "../lib/config.js";
import { setEdgeKey } from "../lib/edge-key.js";
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
import { c, emit, fail, isJsonMode } from "../lib/out.js";
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
      if (skippedLocalPlugins.length > 0) {
        process.stderr.write(
          `  ${c.yellow("note:")} skipped ${skippedLocalPlugins.length} local-path plugin(s) (not reproducible on another machine): ${skippedLocalPlugins.join(", ")}\n`,
        );
      }
      process.stderr.write(
        `  ${c.dim("safe to commit:")} encrypted with scrypt + AES-256-GCM. Lose the passphrase and the contents are unrecoverable.\n`,
      );
    },
    {
      out: outPath,
      profiles: payload.profiles.map((p) => p.name),
      plugins: payload.plugins.length,
      skipped_local_plugins: skippedLocalPlugins,
    },
  );
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
  const errors: Array<{ name: string; reason: string }> = [];

  for (const bp of payload.profiles) {
    const existing = await getProfile(bp.name);
    if (existing && !opts.overwrite) {
      skipped.push(bp.name);
      continue;
    }
    try {
      await applyProfile(bp);
      restored.push(bp.name);
    } catch (err) {
      errors.push({
        name: bp.name,
        reason: err instanceof Error ? err.message : String(err),
      });
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

  emit(
    () => {
      if (restored.length > 0) {
        process.stderr.write(
          `${c.green("✓")} restored ${restored.length} profile(s): ${restored.join(", ")}\n`,
        );
      }
      if (skipped.length > 0) {
        process.stderr.write(
          `${c.yellow("·")} skipped ${skipped.length} existing profile(s) (pass --overwrite to replace): ${skipped.join(", ")}\n`,
        );
      }
      for (const e of errors) {
        process.stderr.write(
          `${c.red("✗")} ${e.name}: ${e.reason}\n`,
        );
      }
      if (!opts.skipPlugins) {
        if (pluginsRestored.length > 0) {
          process.stderr.write(
            `${c.green("✓")} restored ${pluginsRestored.length} plugin(s): ${pluginsRestored.join(", ")}\n`,
          );
        }
        for (const f of pluginsFailed) {
          process.stderr.write(
            `${c.red("✗")} plugin ${f.name} (${pluginSpec(payload.plugins.find((x) => x.name === f.name)!)}): ${f.reason}\n`,
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
          `  ${c.dim("active profile:")} ${c.bold(payload.currentProfile)}\n`,
        );
      }
    },
    {
      restored,
      skipped,
      errors,
      plugins_restored: pluginsRestored,
      plugins_failed: pluginsFailed,
      active_profile: payload.currentProfile,
    },
  );
}

async function applyProfile(bp: BackupProfile): Promise<void> {
  const { entry, secrets } = profileEntryFromBackup(bp);
  // Write keychain entries BEFORE the config so a partial failure leaves
  // the most-recent state (the config file is the authoritative "we know
  // about this profile" marker).
  setKey(entry.baseUrl, secrets.apiKey);
  if (secrets.cf) setCloudflareServiceAuth(entry.baseUrl, secrets.cf);
  if (secrets.edgeKey && entry.edgeWorkerUrl) {
    setEdgeKey(entry.edgeWorkerUrl, secrets.edgeKey);
  }
  await setProfile(bp.name, entry);
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
