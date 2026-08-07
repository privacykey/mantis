export function xmlEscape(s: string): string {
  return (
    s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;")
      // Strip characters that are illegal in XML 1.0 — all C0 control bytes
      // except tab (0x09), LF (0x0A), CR (0x0D), plus DEL (0x7F). An operator
      // memo carrying e.g. a stray \x00/\x07 would otherwise produce a
      // malformed .docx/.xlsx/.pptx/.svg that silently fails to open, breaking
      // the canary. See XML 1.0 §2.2 (Char production).
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
      // The Char production ALSO forbids lone (unpaired) UTF-16 surrogates.
      // A truncated emoji or crafted input can leave a high surrogate with no
      // trailing low surrogate (or vice versa), which is not a valid Unicode
      // scalar value and yields a malformed document. Strip ONLY unpaired
      // surrogates — a valid pair (e.g. 😀 = U+D83D U+DE00) must survive intact.
      .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "")
      // ...and the permanent noncharacters U+FDD0–U+FDEF and U+FFFE/U+FFFF,
      // which are likewise excluded from the Char production.
      .replace(/[﷐-﷯￾￿]/g, "")
  );
}

/**
 * Break the trigger URL into the parts the credential-store formats need.
 *
 * A cookie jar records domain and path as separate columns, a .netrc keys on
 * the bare hostname, and an .ovpn wants host and port — none of them take a
 * URL. Falls back rather than throwing: a malformed URL should degrade to an
 * obviously-inert file, not 500 a download the operator is waiting on.
 */
export function splitUrl(url: string): {
  host: string;
  port: string;
  path: string;
  secure: boolean;
  origin: string;
} {
  try {
    const u = new URL(url);
    const secure = u.protocol === "https:";
    return {
      host: u.hostname,
      port: u.port || (secure ? "443" : "80"),
      path: u.pathname || "/",
      secure,
      origin: u.origin,
    };
  } catch {
    return {
      host: "mantis.invalid",
      port: "443",
      path: "/",
      secure: true,
      origin: "https://mantis.invalid",
    };
  }
}

export type DocOptions = {
  title: string;
  url: string;
  body?: string[];
  /** Used by apple-wallet only — the key's publicId (becomes pass.serialNumber). */
  publicId?: string;
  /** Used by apple-wallet only — the key UUID (used to derive authenticationToken). */
  keyId?: string;
};

/**
 * Body used when the operator supplies none.
 *
 * This deliberately reads as a real internal document. The previous default
 * said "Replace this placeholder text with the actual content you want" —
 * accurate as an instruction, fatal as a canary: a file planted straight from
 * the dashboard announced itself to the first person who opened it. Anyone who
 * opens a canary is exactly the person who must not realise what it is.
 */
export const DEFAULT_BODY = [
  "CONFIDENTIAL — INTERNAL DISTRIBUTION ONLY",
  "",
  "Prepared for the leadership working group. Circulation outside the group requires sign-off from Legal and People Ops.",
  "",
  "1. Summary",
  "",
  "Headcount and compensation data for the current review cycle has been consolidated from the regional submissions. Two regions remain provisional pending reconciliation of contractor spend.",
  "",
  "2. Status",
  "",
  "Figures in this draft are pre-decisional and should not be quoted. The reconciled set replaces this document once Finance signs off.",
  "",
  "3. Next steps",
  "",
  "Comments to the working group by end of week. Final version circulates ahead of the quarterly review.",
];

export type FileFormat =
  | "docx"
  | "xlsx"
  | "pptx"
  | "pdf"
  | "folder"
  | "nfc-label"
  | "apple-wallet"
  | "svg"
  | "html"
  | "md"
  | "eml"
  | "ics"
  | "vcf"
  | "rtf"
  // Credential and config stores. These are where an intruder who already has
  // a shell goes looking, and where forensic and infostealer tooling greps for
  // URLs and secrets — so a bait URL sitting in one is found by exactly the
  // person you want to catch. See CREDENTIAL_FORMATS for how each fires.
  | "cookies"
  | "bookmarks"
  | "env"
  | "aws-credentials"
  | "netrc"
  | "kubeconfig"
  | "ovpn"
  | "rdp";

/**
 * Formats whose bait URL fires only when a human (or a tool they point at it)
 * actually *uses* the URL — as opposed to the document formats, which beacon
 * the moment the file is rendered.
 *
 * Worth being honest about the difference: a .docx fires on open, a .netrc
 * fires when something authenticates to the host in it. Both are useful; only
 * one is automatic, and the dashboard says so per preset.
 */
export const CREDENTIAL_FORMATS = [
  "cookies",
  "bookmarks",
  "env",
  "aws-credentials",
  "netrc",
  "kubeconfig",
  "ovpn",
  "rdp",
] as const satisfies readonly FileFormat[];

/**
 * Formats whose canonical filename is part of the disguise.
 *
 * A cookie jar named `payroll-laptop.txt` is not a cookie jar. For these the
 * memo names the *containing folder* in a bulk zip and the file itself keeps
 * the name the real thing has, so it survives being dropped in place.
 */
export const FIXED_BASENAME: Partial<Record<FileFormat, string>> = {
  cookies: "cookies.txt",
  bookmarks: "bookmarks.html",
  env: ".env",
  "aws-credentials": "credentials",
  netrc: ".netrc",
  kubeconfig: "config",
};

// Single-file document formats that embed the key's beacon and are meant to be
// planted one at a time. The first of these a key is downloaded as is recorded
// on the key (keys.firstDownloadFormat); the dashboard then nudges operators to
// keep one filetype per key so each hit traces back to a single planted file.
// Excludes the `folder` bundle (deliberately many files under one key) and the
// `apple-wallet` / `nfc-label` physical vectors, which aren't planted documents.
export const ATTRIBUTION_FORMATS = [
  "docx",
  "xlsx",
  "pptx",
  "pdf",
  "svg",
  "html",
  "md",
  "eml",
  "ics",
  "vcf",
  "rtf",
  "cookies",
  "bookmarks",
  "env",
  "aws-credentials",
  "netrc",
  "kubeconfig",
  "ovpn",
  "rdp",
] as const satisfies readonly FileFormat[];

export function isAttributionFormat(v: string): v is FileFormat {
  return (ATTRIBUTION_FORMATS as readonly string[]).includes(v);
}

export const FILE_MIME: Record<FileFormat, string> = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  pdf: "application/pdf",
  folder: "application/zip",
  "nfc-label": "application/pdf",
  "apple-wallet": "application/vnd.apple.pkpass",
  svg: "image/svg+xml",
  html: "text/html; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  eml: "message/rfc822",
  ics: "text/calendar; charset=utf-8",
  vcf: "text/vcard; charset=utf-8",
  rtf: "application/rtf",
  // Served as plain text so a browser shows them rather than trying to run or
  // render them — these are meant to be inspected before being planted.
  cookies: "text/plain; charset=utf-8",
  bookmarks: "text/html; charset=utf-8",
  env: "text/plain; charset=utf-8",
  "aws-credentials": "text/plain; charset=utf-8",
  netrc: "text/plain; charset=utf-8",
  kubeconfig: "text/yaml; charset=utf-8",
  ovpn: "text/plain; charset=utf-8",
  rdp: "text/plain; charset=utf-8",
};

export const FILE_EXT: Record<FileFormat, string> = {
  docx: "docx",
  xlsx: "xlsx",
  pptx: "pptx",
  pdf: "pdf",
  folder: "zip",
  "nfc-label": "pdf",
  "apple-wallet": "pkpass",
  svg: "svg",
  html: "html",
  md: "md",
  eml: "eml",
  ics: "ics",
  vcf: "vcf",
  rtf: "rtf",
  // Extensions for the formats whose real name has none (or is dotfile-only);
  // FIXED_BASENAME overrides these wherever the canonical name matters.
  cookies: "txt",
  bookmarks: "html",
  env: "env",
  "aws-credentials": "ini",
  netrc: "netrc",
  kubeconfig: "yaml",
  ovpn: "ovpn",
  rdp: "rdp",
};
