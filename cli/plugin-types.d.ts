/**
 * Types for mantis CLI plugins.
 *
 * Plugin authors: copy this file into your plugin repo and import the types
 * from it. The CLI loads plugins dynamically and does not link against this
 * file at runtime — it's purely for authoring ergonomics.
 *
 * Plugin layout:
 *   my-mantis-plugin/
 *     mantis-plugin.json   — manifest (declares installer types + file formats)
 *     index.js             — entry (exports generator functions)
 *     package.json         — optional, for npm deps. CLI runs `npm ci --omit=dev`
 *                            (or `npm install --omit=dev` if no lockfile) at
 *                            install time.
 *
 * Manifest example:
 *
 *   {
 *     "name": "mantis-rar",
 *     "version": "1.0.0",
 *     "entry": "./index.js",
 *     "installers": [
 *       {
 *         "type": "winrar-shortcut",
 *         "name": "Windows RAR archive bait",
 *         "description": "Fires when a baited shortcut inside the archive is opened.",
 *         "os": "windows"
 *       }
 *     ]
 *   }
 *
 * Entry example (CommonJS):
 *
 *   module.exports = {
 *     installers: {
 *       "winrar-shortcut": async ({ url, keyId, memo }) => ({
 *         filename: `bait-${keyId.slice(0, 8)}.rar`,
 *         mime: "application/vnd.rar",
 *         content: buildArchive(url),
 *         install: ["# unzip on target host"],
 *         uninstall: ["# delete the .rar"],
 *         notes: "Fires on first extract."
 *       })
 *     }
 *   };
 */

export type InstallerInput = {
  /** Public trigger URL — embed this in your generated content. */
  url: string;
  /** Key UUID — useful for unique-per-key file names, never for the URL itself. */
  keyId: string;
  /** Human-readable memo the operator gave the key. */
  memo: string;
  /** Set by `mantis install --hostname <host>` (used by the built-in js-clone-detector). */
  hostname?: string;
};

export type Installer = {
  filename: string;
  mime: string;
  /** Generated snippet body. Plain text or binary-as-string. */
  content: string;
  /** Operator-facing install steps (printed verbatim). */
  install: string[];
  /** Operator-facing uninstall steps (printed verbatim). */
  uninstall: string[];
  /** Optional caveat / explanation shown alongside the steps. */
  notes?: string;
};

export type FormatInput = {
  /** Memo the operator gave the key — useful as a document title / filename hint. */
  title: string;
  url: string;
  publicId: string;
  keyId: string;
};

export type Plugin = {
  installers?: Record<
    string,
    (input: InstallerInput) => Promise<Installer> | Installer
  >;
  formats?: Record<
    string,
    (input: FormatInput) => Promise<Buffer> | Buffer
  >;
};
