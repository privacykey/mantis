import { execFile } from "node:child_process";
import { access, cp, lstat, mkdir, rename, rm, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";
import { BUILTIN_FORMAT_IDS, BUILTIN_INSTALLER_TYPES } from "./builtins.js";
import {
  PLUGIN_INSTALL_DIR,
  pluginDir,
  readLockfile,
  removeLockEntry,
  upsertLockEntry,
  type LockEntry,
} from "./lockfile.js";
import {
  loadAndVerifyPlugin,
  loadManifestOnly,
  type LoadedPlugin,
} from "./registry.js";

const exec = promisify(execFile);

export type InstallSpec =
  | { kind: "github"; owner: string; repo: string; ref?: string }
  | { kind: "local"; path: string };

/**
 * Parses `mantis plugin add` arguments. Accepted shapes:
 *   - owner/repo            → GitHub default branch
 *   - owner/repo@v1.2.3     → tag
 *   - owner/repo@<40-sha>   → commit
 *   - owner/repo@branch     → branch
 *   - ./relative/path       → local directory
 *   - /absolute/path        → local directory
 */
export function parseInstallSpec(input: string): InstallSpec {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("empty plugin spec");

  // Local path: anything starting with ., /, or ~.
  if (trimmed.startsWith(".") || isAbsolute(trimmed) || trimmed.startsWith("~")) {
    const path = trimmed.startsWith("~")
      ? trimmed.replace(/^~/, process.env.HOME ?? "")
      : resolve(trimmed);
    return { kind: "local", path };
  }

  const m = /^([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)\/([A-Za-z0-9._-]+?)(?:@(.+))?$/.exec(
    trimmed,
  );
  if (!m) {
    throw new Error(
      `unrecognized plugin spec "${input}". Expected owner/repo[@ref] or a local path.`,
    );
  }
  const [, owner, repo, ref] = m;
  return { kind: "github", owner: owner!, repo: repo!, ref };
}

export type InstallOutcome = {
  loaded: LoadedPlugin;
  entry: LockEntry;
};

/**
 * Stage → validate → conflict-check → move → npm install → load. Staging
 * dir is removed on any failure.
 */
export async function installPlugin(spec: InstallSpec): Promise<InstallOutcome> {
  await mkdir(PLUGIN_INSTALL_DIR, { recursive: true });

  const stamp = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const staging = `${PLUGIN_INSTALL_DIR}/.staging-${stamp}`;

  let resolvedSha = "";
  let requestedRef = "";
  let sourceLabel = "";

  try {
    if (spec.kind === "github") {
      const url = `https://github.com/${spec.owner}/${spec.repo}.git`;
      sourceLabel = `${spec.owner}/${spec.repo}`;
      requestedRef = spec.ref ?? "";
      // `--` separates positionals so spec.ref / url can't be parsed as flags.
      await exec(
        "git",
        ["clone", "--depth", "1", "--", url, staging],
        { env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
      );
      if (spec.ref) {
        // --depth 1 cloned HEAD only; fetch the ref explicitly.
        await exec("git", [
          "-C",
          staging,
          "fetch",
          "--depth",
          "1",
          "origin",
          "--",
          spec.ref,
        ]);
        await exec("git", ["-C", staging, "checkout", "FETCH_HEAD"]);
      }
      const { stdout } = await exec("git", ["-C", staging, "rev-parse", "HEAD"]);
      resolvedSha = stdout.trim();
    } else {
      sourceLabel = spec.path;
      await assertDir(spec.path);
      // lstat-on-leaf only (not realpath) so /tmp → /private/tmp on macOS
      // still works; we only reject when the leaf itself is a symlink.
      const linkInfo = await lstat(spec.path);
      if (linkInfo.isSymbolicLink()) {
        throw new Error(
          `${spec.path} is a symlink. Pass the real directory path instead.`,
        );
      }
      // verbatimSymlinks: inner symlinks copy as-is instead of dereferencing
      // into their targets (avoids pulling in files outside the plugin dir).
      await cp(spec.path, staging, {
        recursive: true,
        verbatimSymlinks: true,
      });
    }

    // Manifest-only — don't execute the staged plugin's entry until after
    // the conflict check + move. Full verification happens at the end.
    const stagedPlugin = await loadManifestOnly(staging);
    const manifestName = stagedPlugin.manifest.name;

    const builtinConflicts: string[] = [];
    for (const i of stagedPlugin.installers) {
      if (BUILTIN_INSTALLER_TYPES.has(i.type)) {
        builtinConflicts.push(`installer type "${i.type}" (built-in)`);
      }
    }
    for (const f of stagedPlugin.formats) {
      if (BUILTIN_FORMAT_IDS.has(f.id)) {
        builtinConflicts.push(`format id "${f.id}" (built-in)`);
      }
    }
    if (builtinConflicts.length > 0) {
      throw new Error(
        `plugin ${manifestName} conflicts with: ${builtinConflicts.join(", ")}`,
      );
    }

    const lock = await readLockfile();
    for (const p of lock.plugins) {
      if (p.name === manifestName) continue; // self-replace on upgrade
      // Manifest-only walk — read declared ids, never execute their code.
      try {
        const other = await loadManifestOnly(pluginDir(p.name));
        for (const i of stagedPlugin.installers) {
          if (other.installers.some((x) => x.type === i.type)) {
            throw new Error(
              `installer type "${i.type}" already provided by installed plugin "${p.name}"`,
            );
          }
        }
        for (const f of stagedPlugin.formats) {
          if (other.formats.some((x) => x.id === f.id)) {
            throw new Error(
              `format id "${f.id}" already provided by installed plugin "${p.name}"`,
            );
          }
        }
      } catch {
        // Broken sibling plugins are treated as having no ids.
      }
    }

    // Upgrade-overwrite is fine; both paths share a filesystem so rename(2)
    // never returns EXDEV.
    const final = pluginDir(manifestName);
    await rm(final, { recursive: true, force: true });
    await rename(staging, final);

    // --ignore-scripts is mandatory: npm's lifecycle hooks would otherwise
    // be RCE on plugin add. Plugins that need a build step must vendor the
    // compiled artifact.
    const hasPkg = await fileExists(`${final}/package.json`);
    if (hasPkg) {
      const hasLock = await fileExists(`${final}/package-lock.json`);
      const npmArgs = hasLock
        ? ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"]
        : ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"];
      await exec("npm", npmArgs, { cwd: final });
    }

    // One-time entry import + shape check, so broken plugins fail fast at
    // install rather than on first use.
    const loaded = await loadAndVerifyPlugin(final);
    const entry: LockEntry = {
      name: manifestName,
      requestedRef,
      resolvedSha,
      source: sourceLabel,
      version: loaded.manifest.version,
      installedAt: new Date().toISOString(),
    };
    await upsertLockEntry(entry);
    return { loaded, entry };
  } catch (err) {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

export async function uninstallPlugin(name: string): Promise<boolean> {
  const dir = pluginDir(name);
  let existed = false;
  try {
    await access(dir);
    existed = true;
  } catch {
    // not on disk; may still be in lockfile
  }
  await rm(dir, { recursive: true, force: true });
  const wasInLockfile = await removeLockEntry(name);
  return existed || wasInLockfile;
}

async function assertDir(path: string): Promise<void> {
  const s = await stat(path).catch(() => null);
  if (!s || !s.isDirectory()) {
    throw new Error(`not a directory: ${path}`);
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
