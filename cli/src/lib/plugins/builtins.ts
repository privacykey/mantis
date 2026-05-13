// Conflict-check baseline for plugin-provided ids. Mirrors the server's
// canonical list; kept in sync manually when new built-ins land.

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
]);
