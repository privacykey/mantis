import { ALL_INSTALL_TYPES } from "@mantis/core/installers";

// Conflict-check baseline for plugin-provided ids: a plugin claiming one of
// these is rejected at install time rather than silently shadowing a built-in.
//
// Installer types are derived from @mantis/core's canonical list, so that set
// cannot drift. Download formats still mirror the server's ALL_FORMATS
// (src/lib/docs) by hand — that module is server-only (it pulls in
// passkit-generator, pdf-lib, …) — and the format set had already drifted
// once, missing every credential-store format, which meant a plugin could
// claim those ids and the conflict check would wave it through.
// tests/builtins-drift.test.ts fails when the format set diverges.

export const BUILTIN_INSTALLER_TYPES = new Set<string>(ALL_INSTALL_TYPES);

export const BUILTIN_FORMAT_IDS = new Set<string>([
  "qr",
  "docx",
  "xlsx",
  "pptx",
  "pdf",
  "folder",
  "svg",
  "html",
  "md",
  "eml",
  "ics",
  "vcf",
  "nfc-label",
  "apple-wallet",
  "rtf",
  "cookies",
  "bookmarks",
  "env",
  "aws-credentials",
  "netrc",
  "kubeconfig",
  "ovpn",
  "rdp",
]);
