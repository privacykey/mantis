import { c, emit, fail, isJsonMode, isQuiet } from "../lib/out.js";
import {
  installPlugin,
  parseInstallSpec,
  uninstallPlugin,
} from "../lib/plugins/install.js";
import {
  findLockEntry,
  readLockfile,
  type LockEntry,
} from "../lib/plugins/lockfile.js";
import {
  invalidateRegistry,
  loadRegistry,
} from "../lib/plugins/registry.js";

let SECURITY_BANNER_SHOWN = false;

function showSecurityBannerOnce(): void {
  if (SECURITY_BANNER_SHOWN) return;
  SECURITY_BANNER_SHOWN = true;
  if (isJsonMode() || isQuiet()) return;
  process.stderr.write(
    `${c.yellow("note:")} plugins run with your user permissions on this machine.\n` +
      `      Only install plugins from sources you trust. Pin to a commit SHA\n` +
      `      (\`add owner/repo@<sha>\`) to avoid silent drift on upgrade.\n\n`,
  );
}

export async function pluginAddCmd(spec: string): Promise<void> {
  let parsed;
  try {
    parsed = parseInstallSpec(spec);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }

  showSecurityBannerOnce();

  try {
    const { loaded, entry } = await installPlugin(parsed);
    invalidateRegistry();
    emit(
      () => {
        const w = process.stderr.write.bind(process.stderr);
        w(`${c.green("✓")} installed ${c.bold(loaded.manifest.name)}@${entry.version}\n`);
        if (entry.resolvedSha) {
          w(`  ${c.dim("commit:")}  ${entry.resolvedSha}\n`);
        }
        if (loaded.installers.length > 0) {
          w(`  ${c.dim("installers:")} ${loaded.installers.map((i) => i.type).join(", ")}\n`);
        }
        if (loaded.formats.length > 0) {
          w(`  ${c.dim("formats:")}    ${loaded.formats.map((f) => f.id).join(", ")}\n`);
        }
      },
      {
        name: loaded.manifest.name,
        version: entry.version,
        source: entry.source,
        resolved_sha: entry.resolvedSha || null,
        installers: loaded.installers.map((i) => i.type),
        formats: loaded.formats.map((f) => f.id),
      },
    );
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

export async function pluginListCmd(): Promise<void> {
  const lock = await readLockfile();
  const registry = await loadRegistry();

  const rows = lock.plugins.map((p) => {
    const loaded = registry.plugins.find((l) => l.manifest.name === p.name);
    const failure = registry.errors.find((e) => e.name === p.name);
    return {
      name: p.name,
      version: p.version,
      source: p.source,
      resolved_sha: p.resolvedSha || null,
      installed_at: p.installedAt,
      installers: loaded?.installers.map((i) => i.type) ?? [],
      formats: loaded?.formats.map((f) => f.id) ?? [],
      load_error: failure?.error ?? null,
    };
  });

  emit(
    () => {
      if (rows.length === 0) {
        process.stderr.write(
          `${c.dim("no plugins installed. Run `mantis plugin add owner/repo` to install one.")}\n`,
        );
        return;
      }
      const w = process.stdout.write.bind(process.stdout);
      for (const r of rows) {
        w(`${c.bold(r.name)}@${r.version}\n`);
        w(`  ${c.dim("source:")}  ${r.source}\n`);
        if (r.resolved_sha) {
          w(`  ${c.dim("commit:")}  ${r.resolved_sha.slice(0, 12)}\n`);
        }
        if (r.installers.length > 0) {
          w(`  ${c.dim("installers:")} ${r.installers.join(", ")}\n`);
        }
        if (r.formats.length > 0) {
          w(`  ${c.dim("formats:")}    ${r.formats.join(", ")}\n`);
        }
        if (r.load_error) {
          w(`  ${c.red("load error:")} ${r.load_error}\n`);
        }
        w("\n");
      }
    },
    rows,
  );
}

export async function pluginRemoveCmd(name: string): Promise<void> {
  const entry = await findLockEntry(name);
  if (!entry) {
    return fail(`plugin "${name}" not installed`);
  }
  const removed = await uninstallPlugin(name);
  invalidateRegistry();
  if (!removed) {
    return fail(`plugin "${name}" not on disk and not in lockfile`);
  }
  emit(
    () => {
      process.stderr.write(`${c.green("✓")} removed ${c.bold(name)}\n`);
    },
    { name, removed: true },
  );
}

export async function pluginUpgradeCmd(name: string): Promise<void> {
  const entry = await findLockEntry(name);
  if (!entry) {
    return fail(`plugin "${name}" not installed`);
  }
  // SHA-pinned installs are immutable.
  if (
    entry.resolvedSha &&
    entry.requestedRef &&
    entry.requestedRef === entry.resolvedSha
  ) {
    return fail(
      `${name} is pinned to ${entry.resolvedSha}. Remove and re-add with @<ref> to move.`,
    );
  }
  if (!entry.source.includes("/") || entry.source.startsWith("/")) {
    return fail(
      `${name} was installed from a local path (${entry.source}). Re-add manually with \`mantis plugin add ${entry.source}\`.`,
    );
  }

  let parsed;
  try {
    const ref = entry.requestedRef ? `@${entry.requestedRef}` : "";
    parsed = parseInstallSpec(`${entry.source}${ref}`);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }

  try {
    const { entry: newEntry } = await installPlugin(parsed);
    invalidateRegistry();
    const moved = newEntry.resolvedSha !== entry.resolvedSha;
    emit(
      () => {
        const w = process.stderr.write.bind(process.stderr);
        if (moved) {
          w(`${c.green("✓")} ${c.bold(name)}: ${c.dim(entry.resolvedSha.slice(0, 12) || "?")} → ${newEntry.resolvedSha.slice(0, 12) || "?"}\n`);
        } else {
          w(`${c.dim("·")} ${name} already at latest (${newEntry.resolvedSha.slice(0, 12) || "?"})\n`);
        }
      },
      {
        name,
        moved,
        previous_sha: entry.resolvedSha || null,
        current_sha: newEntry.resolvedSha || null,
      },
    );
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

export type ResolvedInstallerEntry = {
  type: string;
  pluginName: string;
};

/** Built-in + plugin installer types, for `mantis install` error messages. */
export async function listAvailableInstallerTypes(
  builtins: readonly string[],
): Promise<{
  builtins: readonly string[];
  plugins: ResolvedInstallerEntry[];
}> {
  const registry = await loadRegistry();
  const plugins: ResolvedInstallerEntry[] = [];
  for (const [type, inst] of registry.installerByType) {
    plugins.push({ type, pluginName: inst.pluginName });
  }
  return { builtins, plugins };
}

export type { LockEntry };
