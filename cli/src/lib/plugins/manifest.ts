import { z } from "zod";

// Plugin manifest schema for `mantis-plugin.json`.

const idShape = z
  .string()
  .min(2)
  .max(64)
  .regex(/^[a-z][a-z0-9-]*$/, "must be lowercase letters/digits/dashes");

const osShape = z.enum([
  "macos",
  "linux",
  "windows",
  "posix",
  "web",
  "tag",
  "other",
]);

const installerDeclSchema = z
  .object({
    type: idShape,
    name: z.string().min(1).max(200),
    description: z.string().min(1).max(500),
    os: osShape.default("other"),
  })
  .strict();

const formatDeclSchema = z
  .object({
    id: idShape,
    name: z.string().min(1).max(200),
    extension: z
      .string()
      .min(1)
      .max(16)
      .regex(/^[a-z0-9]+$/i, "must be alphanumeric"),
    mime: z.string().min(3).max(200),
    description: z.string().max(500).optional(),
  })
  .strict();

// Relative .js/.cjs/.mjs path inside the plugin dir. Rejects absolute paths
// and `..` segments to prevent the entry from escaping the plugin dir on
// resolve(); registry.ts re-checks with `startsWith(dir)` as belt-and-braces.
const entryPathShape = z
  .string()
  .min(1)
  .max(200)
  .regex(
    /^\.?\/?[A-Za-z0-9_./-]+\.(?:js|cjs|mjs)$/,
    "must be a relative .js / .cjs / .mjs path under the plugin dir",
  )
  .refine((p) => !p.split("/").includes(".."), {
    message: "must not contain `..` segments (would escape the plugin dir)",
  });

export const pluginManifestSchema = z
  .object({
    name: idShape,
    version: z.string().min(1).max(50),
    description: z.string().max(500).optional(),
    /** npm-style semver predicate. Currently informational only — not enforced. */
    mantisCli: z.string().max(50).optional(),
    /** Relative path from manifest dir. Defaults to "./index.js". */
    entry: entryPathShape.default("./index.js"),
    installers: z.array(installerDeclSchema).max(50).optional(),
    formats: z.array(formatDeclSchema).max(50).optional(),
  })
  .strict()
  .refine(
    (m) =>
      (m.installers && m.installers.length > 0) ||
      (m.formats && m.formats.length > 0),
    {
      message: "manifest must declare at least one installer or format",
    },
  );

export type PluginManifest = z.infer<typeof pluginManifestSchema>;
export type InstallerDecl = z.infer<typeof installerDeclSchema>;
export type FormatDecl = z.infer<typeof formatDeclSchema>;
