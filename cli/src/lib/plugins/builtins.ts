// Conflict-check baseline for plugin-provided ids: a plugin claiming one of
// these is rejected at install time rather than silently shadowing a built-in.
//
// These mirror the server's canonical lists (ALL_INSTALL_TYPES in
// src/lib/installers, ALL_FORMATS in src/lib/docs) and are kept in sync by
// hand. Both had already drifted — the installer set was missing
// `homeassistant-receiver`, and the format set every credential-store format —
// which meant a plugin could claim those ids and the conflict check would wave
// it through. tests/builtins-drift.test.ts now fails when they diverge.

export const BUILTIN_INSTALLER_TYPES = new Set<string>([
  "shell",
  "shell-sudo",
  "macos-login",
  "macos-boot",
  "macos-wake",
  "macos-network",
  "linux-boot",
  "linux-wake",
  "linux-network",
  "windows-logon",
  "windows-wake",
  "windows-network",
  "css-background",
  "js-clone-detector",
  "nfc-ndef",
  "homeassistant",
  "homeassistant-receiver",
  "scrypted",
]);

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
