import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { c, emit, isJsonMode } from "../lib/out.js";
import type { InstallerMeta } from "../lib/api.js";
import { BUILTIN_INSTALLER_TYPES } from "../lib/plugins/builtins.js";
import { loadRegistry } from "../lib/plugins/registry.js";
import { resolveKeyRef } from "../lib/resolve.js";
import { withClient, type GlobalOpts } from "../lib/runner.js";

export type InstallOpts = GlobalOpts & {
  type?: string;
  out?: string;
  hostname?: string;
};

export async function installCmd(id: string, opts: InstallOpts): Promise<void> {
  const type = opts.type;

  const registry = await loadRegistry();
  const pluginEntry = type ? registry.installerByType.get(type) : undefined;
  const pluginTypes = Array.from(registry.installerByType.keys()).sort();
  const builtins = Array.from(BUILTIN_INSTALLER_TYPES).sort();

  if (!type) {
    throw new Error(
      `--type is required. Built-in: ${builtins.join(", ")}` +
        (pluginTypes.length > 0 ? `. Plugin: ${pluginTypes.join(", ")}` : "") +
        ".",
    );
  }
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

  await withClient(opts, async (client) => {
    const fullId = await resolveKeyRef(client, id);

    let meta: InstallerMeta;
    let pluginName: string | null = null;

    if (pluginEntry) {
      // Plugin path: server gives us the key URL, plugin renders locally.
      const key = await client.getKey(fullId);
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
        // Plugin `os` is a broader union than server `os`; cast is best-effort.
        os: pluginEntry.os as InstallerMeta["os"],
        filename: produced.filename,
        content: produced.content,
        install: produced.install,
        uninstall: produced.uninstall,
        notes: produced.notes,
      };
    } else {
      meta = await client.fetchInstaller(fullId, type, opts.hostname);
    }

    if (opts.out) {
      const dest = resolve(opts.out);
      await writeFile(dest, meta.content);
      if (!isJsonMode()) {
        process.stderr.write(
          `${c.green("✓")} wrote ${meta.filename} → ${dest}\n`,
        );
      }
    }

    emit(
      () => {
        const w = process.stdout.write.bind(process.stdout);
        if (!opts.out) {
          // Pipe-friendly: snippet on stdout, install/uninstall steps on stderr.
          process.stdout.write(meta.content);
        }
        const err = process.stderr.write.bind(process.stderr);
        err(
          `\n${c.bold(meta.name)}${pluginName ? c.dim(` (plugin: ${pluginName})`) : ""}\n`,
        );
        err(c.dim(meta.description + "\n"));
        if (meta.notes) err(c.dim("note: " + meta.notes + "\n"));
        err(`\n${c.dim("install:")}\n`);
        for (const step of meta.install) {
          err(`  ${step}\n`);
        }
        err(`\n${c.dim("uninstall:")}\n`);
        for (const step of meta.uninstall) {
          err(`  ${step}\n`);
        }
        void w;
      },
      meta,
    );
  });
}
