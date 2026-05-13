import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { isAbsolute, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { readLockfile, pluginDir } from "./lockfile.js";
import {
  pluginManifestSchema,
  type FormatDecl,
  type InstallerDecl,
  type PluginManifest,
} from "./manifest.js";

// The plugin entry-point contract. Plugin authors write either CommonJS or
// ESM modules that export this shape (default export OR named exports).
export type InstallerInput = {
  url: string;
  keyId: string;
  memo: string;
  hostname?: string;
};

export type Installer = {
  filename: string;
  mime: string;
  content: string;
  install: string[];
  uninstall: string[];
  notes?: string;
};

export type FormatInput = {
  title: string;
  url: string;
  publicId: string;
  keyId: string;
};

export type PluginExports = {
  installers?: Record<
    string,
    (input: InstallerInput) => Promise<Installer> | Installer
  >;
  formats?: Record<
    string,
    (input: FormatInput) => Promise<Buffer> | Buffer
  >;
};

export type LoadedInstaller = InstallerDecl & {
  pluginName: string;
  /** Lazy — imports the plugin's entry on first call, caches thereafter. */
  generate: (input: InstallerInput) => Promise<Installer>;
};

export type LoadedFormat = FormatDecl & {
  pluginName: string;
  /** Lazy — imports the plugin's entry on first call, caches thereafter. */
  generate: (input: FormatInput) => Promise<Buffer>;
};

export type LoadedPlugin = {
  manifest: PluginManifest;
  dir: string;
  installers: LoadedInstaller[];
  formats: LoadedFormat[];
};

export type Registry = {
  plugins: LoadedPlugin[];
  installerByType: Map<string, LoadedInstaller>;
  formatById: Map<string, LoadedFormat>;
  /** Manifests that failed to load — surfaced by `mantis plugin list` so the operator sees broken installs. */
  errors: Array<{ name: string; dir: string; error: string }>;
};

let cached: Registry | null = null;

/**
 * Lazy, once-per-process. Reads each plugin's manifest only — entry
 * modules import on first `generate()` call.
 */
export async function loadRegistry(): Promise<Registry> {
  if (cached) return cached;
  cached = await buildRegistry();
  return cached;
}

/** Forces a rebuild — used after `plugin add` / `plugin remove`. */
export function invalidateRegistry(): void {
  cached = null;
}

async function buildRegistry(): Promise<Registry> {
  const lock = await readLockfile();
  const plugins: LoadedPlugin[] = [];
  const installerByType = new Map<string, LoadedInstaller>();
  const formatById = new Map<string, LoadedFormat>();
  const errors: Registry["errors"] = [];

  for (const entry of lock.plugins) {
    const dir = pluginDir(entry.name);
    try {
      const loaded = await loadManifestOnly(dir);
      plugins.push(loaded);
      for (const i of loaded.installers) {
        if (installerByType.has(i.type)) {
          const owner = installerByType.get(i.type)!.pluginName;
          throw new Error(
            `installer type "${i.type}" already provided by plugin ${owner}`,
          );
        }
        installerByType.set(i.type, i);
      }
      for (const f of loaded.formats) {
        if (formatById.has(f.id)) {
          const owner = formatById.get(f.id)!.pluginName;
          throw new Error(
            `format id "${f.id}" already provided by plugin ${owner}`,
          );
        }
        formatById.set(f.id, f);
      }
    } catch (err) {
      errors.push({
        name: entry.name,
        dir,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { plugins, installerByType, formatById, errors };
}

/**
 * Reads + validates the manifest. Generators are lazy thunks that import
 * the entry on first call. Use loadAndVerifyPlugin for eager verification.
 */
export async function loadManifestOnly(dir: string): Promise<LoadedPlugin> {
  const manifest = await readManifest(dir);
  const entryPath = resolveEntryPath(dir, manifest.entry);
  const cache: { mod?: PluginExports } = {};

  const importEntry = async (): Promise<PluginExports> => {
    if (cache.mod) return cache.mod;
    cache.mod = await loadEntryModule(entryPath);
    return cache.mod;
  };

  const installers: LoadedInstaller[] = (manifest.installers ?? []).map(
    (decl) => ({
      ...decl,
      pluginName: manifest.name,
      generate: async (input) => {
        const mod = await importEntry();
        const fn = mod.installers?.[decl.type];
        if (typeof fn !== "function") {
          throw new Error(
            `${manifest.name} declares installer "${decl.type}" but its entry doesn't export a matching function`,
          );
        }
        return Promise.resolve(fn(input));
      },
    }),
  );

  const formats: LoadedFormat[] = (manifest.formats ?? []).map((decl) => ({
    ...decl,
    pluginName: manifest.name,
    generate: async (input) => {
      const mod = await importEntry();
      const fn = mod.formats?.[decl.id];
      if (typeof fn !== "function") {
        throw new Error(
          `${manifest.name} declares format "${decl.id}" but its entry doesn't export a matching function`,
        );
      }
      return Promise.resolve(fn(input));
    },
  }));

  return { manifest, dir, installers, formats };
}

/** Manifest + eager entry import + shape check. Use after `plugin add`. */
export async function loadAndVerifyPlugin(dir: string): Promise<LoadedPlugin> {
  const loaded = await loadManifestOnly(dir);
  const entryPath = resolveEntryPath(dir, loaded.manifest.entry);
  const mod = await loadEntryModule(entryPath);
  for (const decl of loaded.manifest.installers ?? []) {
    if (typeof mod.installers?.[decl.type] !== "function") {
      throw new Error(
        `${loaded.manifest.name} declares installer "${decl.type}" but its entry doesn't export a matching function`,
      );
    }
  }
  for (const decl of loaded.manifest.formats ?? []) {
    if (typeof mod.formats?.[decl.id] !== "function") {
      throw new Error(
        `${loaded.manifest.name} declares format "${decl.id}" but its entry doesn't export a matching function`,
      );
    }
  }
  return loaded;
}

async function readManifest(dir: string): Promise<PluginManifest> {
  const manifestPath = join(dir, "mantis-plugin.json");
  let rawManifest: string;
  try {
    rawManifest = await readFile(manifestPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`missing mantis-plugin.json at ${dir}`);
    }
    throw err;
  }

  let parsedManifest: unknown;
  try {
    parsedManifest = JSON.parse(rawManifest);
  } catch (err) {
    throw new Error(
      `mantis-plugin.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const result = pluginManifestSchema.safeParse(parsedManifest);
  if (!result.success) {
    const first = result.error.issues[0];
    const path = first?.path.join(".") || "(root)";
    throw new Error(
      `mantis-plugin.json failed validation at ${path}: ${first?.message ?? "unknown"}`,
    );
  }
  return result.data;
}

/**
 * Defense-in-depth path-traversal check. Manifest schema already rejects
 * `..` and absolute paths; this re-asserts the resolved path stays under dir.
 */
function resolveEntryPath(dir: string, entryRel: string): string {
  if (isAbsolute(entryRel)) {
    throw new Error(`plugin entry path must be relative, got "${entryRel}"`);
  }
  const absDir = resolve(dir);
  const entryPath = resolve(absDir, entryRel);
  if (entryPath !== absDir && !entryPath.startsWith(absDir + sep)) {
    throw new Error(
      `plugin entry path "${entryRel}" escapes the plugin directory`,
    );
  }
  return entryPath;
}

async function loadEntryModule(entryPath: string): Promise<PluginExports> {
  // ESM first, fall back to CJS for modules that don't expose named exports.
  try {
    const imported = (await import(pathToFileURL(entryPath).href)) as Record<
      string,
      unknown
    >;
    return normalizePluginExports(imported);
  } catch (esmErr) {
    try {
      const require = createRequire(import.meta.url);
      const cjs = require(entryPath) as Record<string, unknown>;
      return normalizePluginExports(cjs);
    } catch {
      throw new Error(
        `failed to load plugin entry ${entryPath}: ${esmErr instanceof Error ? esmErr.message : esmErr}`,
      );
    }
  }
}

function normalizePluginExports(
  imported: Record<string, unknown>,
): PluginExports {
  // ESM default-export wrapper: `export default { installers, formats }`.
  const def = imported.default;
  if (def && typeof def === "object") {
    const merged = { ...(def as Record<string, unknown>), ...imported };
    return {
      installers: (merged.installers as PluginExports["installers"]) ?? undefined,
      formats: (merged.formats as PluginExports["formats"]) ?? undefined,
    };
  }
  return {
    installers: (imported.installers as PluginExports["installers"]) ?? undefined,
    formats: (imported.formats as PluginExports["formats"]) ?? undefined,
  };
}
