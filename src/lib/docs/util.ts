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

export type DocOptions = {
  title: string;
  url: string;
  body?: string[];
  /** Used by apple-wallet only — the key's publicId (becomes pass.serialNumber). */
  publicId?: string;
  /** Used by apple-wallet only — the key UUID (used to derive authenticationToken). */
  keyId?: string;
};

export const DEFAULT_BODY = [
  "CONFIDENTIAL DRAFT — do not distribute.",
  "",
  "This document is an internal working draft. Replace this placeholder text with the actual content you want to appear in the file.",
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
  | "vcf";

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
};
