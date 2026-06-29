import { generateApplePass } from "@/lib/installers/apple-wallet";
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
  FILE_EXT,
  FILE_MIME,
  isAttributionFormat,
  type DocOptions,
  type FileFormat,
} from "./util";

export type { DocOptions, FileFormat };
export { ATTRIBUTION_FORMATS, FILE_EXT, FILE_MIME, isAttributionFormat };

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
];
