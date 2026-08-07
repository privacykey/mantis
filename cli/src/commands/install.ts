import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { c, emit, isJsonMode } from "../lib/out.js";
import type { InstallerMeta, MantisClient } from "../lib/api.js";
import { applySshOnlyGuard } from "@mantis/core/installers";
import { BUILTIN_INSTALLER_TYPES } from "../lib/plugins/builtins.js";
import { loadRegistry } from "../lib/plugins/registry.js";
import { resolveKeyRef } from "../lib/resolve.js";
import { withClient, type GlobalOpts } from "../lib/runner.js";

export type InstallOpts = GlobalOpts & {
  type?: string;
  out?: string;
  hostname?: string;
  sshOnly?: boolean;
};

export type RunInstallerOpts = {
  type: string;
  out?: string;
  hostname?: string;
  sshOnly?: boolean;
  /** When true, suppress emit() — the caller will emit its own combined output. */
  silent?: boolean;
};

export async function installCmd(id: string, opts: InstallOpts): Promise<void> {
  if (!opts.type) {
    const registry = await loadRegistry();
    const pluginTypes = Array.from(registry.installerByType.keys()).sort();
    const builtins = Array.from(BUILTIN_INSTALLER_TYPES).sort();
    throw new Error(
      `--type is required. Built-in: ${builtins.join(", ")}` +
        (pluginTypes.length > 0 ? `. Plugin: ${pluginTypes.join(", ")}` : "") +
        ".",
    );
  }

  await withClient(opts, async (client) => {
    const fullId = await resolveKeyRef(client, id);
    await runInstaller(client, fullId, {
      type: opts.type!,
      out: opts.out,
      hostname: opts.hostname,
      sshOnly: opts.sshOnly,
    });
  });
}

/**
 * Fetch + (optional) post-process + write/emit an installer for an existing
 * key. Used directly by `installCmd` and chained from `newCmd` after key
 * creation (avoids a second `withClient` and a redundant key lookup).
 */
export async function runInstaller(
  client: MantisClient,
  keyId: string,
  opts: RunInstallerOpts,
): Promise<{ filename: string; writtenTo: string | null }> {
  const { type } = opts;

  const registry = await loadRegistry();
  const pluginEntry = registry.installerByType.get(type);
  const pluginTypes = Array.from(registry.installerByType.keys()).sort();
  const builtins = Array.from(BUILTIN_INSTALLER_TYPES).sort();

  if (!pluginEntry && !BUILTIN_INSTALLER_TYPES.has(type)) {
    throw new Error(
      `unknown installer type "${type}". Built-in: ${builtins.join(", ")}` +
        (pluginTypes.length > 0 ? `. Plugin: ${pluginTypes.join(", ")}` : "") +
        ".",
    );
  }

  if (type === "js-clone-detector" && !opts.hostname) {
    process.stderr.write(
      `${c.yellow("warning:")} --hostname not set; the js-clone-detector snippet will fire on every page including your own.\n`,
    );
  }

  if (opts.sshOnly && type !== "shell" && type !== "shell-sudo") {
    throw new Error(
      `--ssh-only only applies to shell / shell-sudo installers, not ${type}`,
    );
  }

  let meta: InstallerMeta;
  let pluginName: string | null = null;

  if (pluginEntry) {
    const key = await client.getKey(keyId);
    let produced;
    try {
      produced = await pluginEntry.generate({
        url: key.url,
        keyId: key.id,
        memo: key.memo,
        hostname: opts.hostname,
      });
    } catch (err) {
      throw new Error(
        `plugin ${pluginEntry.pluginName} failed to generate "${type}": ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    pluginName = pluginEntry.pluginName;
    meta = {
      type: pluginEntry.type,
      name: pluginEntry.name,
      description: pluginEntry.description,
      os: pluginEntry.os as InstallerMeta["os"],
      filename: produced.filename,
      content: produced.content,
      install: produced.install,
      uninstall: produced.uninstall,
      notes: produced.notes,
    };
  } else {
    meta = await client.fetchInstaller(keyId, type, opts.hostname);
  }

  if (opts.sshOnly) {
    meta = { ...meta, content: applySshOnlyGuard(meta.content) };
  }

  let writtenTo: string | null = null;
  if (opts.out) {
    writtenTo = resolve(opts.out);
    await writeFile(writtenTo, meta.content);
  }

  if (opts.silent) {
    if (writtenTo && !isJsonMode()) {
      process.stderr.write(
        `${c.green("✓")} wrote ${c.bold(meta.type)} installer to ${c.cyan(writtenTo)}\n`,
      );
      for (const step of meta.install) {
        process.stderr.write(`  ${c.dim(step)}\n`);
      }
    }
    return { filename: meta.filename, writtenTo };
  }

  emit(
    () => {
      if (writtenTo) {
        process.stderr.write(
          `${c.green("✓")} wrote ${meta.filename} → ${writtenTo}\n`,
        );
      } else {
        process.stdout.write(meta.content);
      }
      process.stderr.write(
        `\n${c.bold(meta.name)}${pluginName ? c.dim(` (plugin: ${pluginName})`) : ""}\n`,
      );
      process.stderr.write(c.dim(meta.description + "\n"));
      if (meta.notes) {
        process.stderr.write(c.dim("note: " + meta.notes + "\n"));
      }
      process.stderr.write(`\n${c.dim("install:")}\n`);
      for (const step of meta.install) {
        process.stderr.write(`  ${step}\n`);
      }
      process.stderr.write(`\n${c.dim("uninstall:")}\n`);
      for (const step of meta.uninstall) {
        process.stderr.write(`  ${step}\n`);
      }
    },
    meta,
  );

  return { filename: meta.filename, writtenTo };
}
