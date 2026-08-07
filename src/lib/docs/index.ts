import { generateApplePass } from "@/lib/installers/apple-wallet";
import { generateBookmarks } from "./bookmarks";
import { generateOvpn, generateRdp } from "./connection-profiles";
import { generateCookies } from "./cookies";
import {
  generateAwsCredentials,
  generateEnv,
  generateKubeconfig,
  generateNetrc,
} from "./credential-stores";
import { generateRtf } from "./rtf";
import { generateDocx } from "./docx";
import { generateEml } from "./eml";
import { generateFolder } from "./folder";
import { generateHtml } from "./html";
import { generateIcs } from "./ics";
import { generateMarkdown } from "./markdown";
import { generateNfcLabel } from "./nfc-label";
import { generatePdf } from "./pdf";
import { generatePptx } from "./pptx";
import { generateSvg } from "./svg";
import { generateVcf } from "./vcf";
import { generateXlsx } from "./xlsx";
import {
  ATTRIBUTION_FORMATS,
  CREDENTIAL_FORMATS,
  FILE_EXT,
  FILE_MIME,
  FIXED_BASENAME,
  isAttributionFormat,
  type DocOptions,
  type FileFormat,
} from "./util";

export type { DocOptions, FileFormat };
export {
  ATTRIBUTION_FORMATS,
  CREDENTIAL_FORMATS,
  FILE_EXT,
  FILE_MIME,
  FIXED_BASENAME,
  isAttributionFormat,
};

/**
 * Filename to use when saving a generated artifact.
 *
 * Most formats take the memo as the stem — `Q4 payroll.docx` is exactly what a
 * planted document should be called. But a cookie jar named
 * `payroll-laptop.txt` is not a cookie jar: for those the canonical name is
 * part of the disguise, so the memo is dropped and the real name kept.
 */
export function artifactFilename(format: FileFormat, stem: string): string {
  return FIXED_BASENAME[format] ?? `${stem}.${FILE_EXT[format]}`;
}

const generators: Record<FileFormat, (opts: DocOptions) => Promise<Buffer>> = {
  docx: generateDocx,
  xlsx: generateXlsx,
  pptx: generatePptx,
  pdf: generatePdf,
  folder: generateFolder,
  "nfc-label": generateNfcLabel,
  "apple-wallet": (opts) => {
    if (!opts.publicId || !opts.keyId) {
      throw new Error("apple-wallet requires publicId and keyId in DocOptions");
    }
    return generateApplePass({
      publicId: opts.publicId,
      keyId: opts.keyId,
      memo: opts.title,
      triggerUrl: opts.url,
    });
  },
  svg: generateSvg,
  html: generateHtml,
  md: generateMarkdown,
  eml: generateEml,
  ics: generateIcs,
  vcf: generateVcf,
  rtf: generateRtf,
  cookies: generateCookies,
  bookmarks: generateBookmarks,
  env: generateEnv,
  "aws-credentials": generateAwsCredentials,
  netrc: generateNetrc,
  kubeconfig: generateKubeconfig,
  ovpn: generateOvpn,
  rdp: generateRdp,
};

export function generateFile(
  format: FileFormat,
  opts: DocOptions,
): Promise<Buffer> {
  return generators[format](opts);
}

export const ALL_FORMATS: FileFormat[] = [
  "docx",
  "xlsx",
  "pptx",
  "pdf",
  "folder",
  "nfc-label",
  "apple-wallet",
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
];
