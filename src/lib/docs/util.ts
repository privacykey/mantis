export function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
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
