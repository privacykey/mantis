import {
  PDFDocument,
  type PDFFont,
  PDFName,
  PDFString,
  PDFDict,
  PDFArray,
  StandardFonts,
  rgb,
} from "pdf-lib";
import { DEFAULT_BODY, type DocOptions } from "./util";

/**
 * The standard PDF fonts (Helvetica here) only cover WinAnsi, and pdf-lib
 * throws on anything outside it — so a memo in Cyrillic or CJK, one with an
 * emoji, or even a tab, would turn the download into a 500. Substitute rather
 * than fail: unsupported characters draw as "?" (whitespace controls as a
 * space). The document's metadata title still carries the original text.
 */
export function winAnsiSafe(font: PDFFont, text: string): string {
  const supported = new Set(font.getCharacterSet());
  let out = "";
  for (const ch of text) {
    if (supported.has(ch.codePointAt(0) ?? -1)) out += ch;
    else out += ch === "\t" || ch === "\n" || ch === "\r" ? " " : "?";
  }
  return out;
}

// PDFString.of() writes a literal string verbatim, so the three characters
// that are structural inside one have to be escaped by the caller.
function pdfLiteral(value: string): PDFString {
  return PDFString.of(value.replace(/[\\()]/g, "\\$&"));
}

/**
 * Generates a PDF combining two mantis techniques so each fires in different readers:
 *
 *   1. /OpenAction → /URI: many enterprise PDF readers (Adobe Reader, Foxit, etc.) follow
 *      this on document open, sometimes with a one-time trust prompt. Doesn't work in
 *      Chrome's PDFium viewer.
 *   2. Visible clickable link annotation: covers the case where the user reads the PDF
 *      and clicks the obvious link.
 *
 * The URL itself is deliberately NOT drawn on the page — only the footer's
 * "View the latest version online" link text is — so copy/paste of the page
 * text does not carry it.
 */
export async function generatePdf(opts: DocOptions): Promise<Buffer> {
  const body = opts.body ?? DEFAULT_BODY;
  const pdf = await PDFDocument.create();
  pdf.setTitle(opts.title);
  pdf.setProducer("mantis");
  pdf.setCreator("mantis");
  pdf.setCreationDate(new Date());

  const page = pdf.addPage([612, 792]); // US Letter
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdf.embedFont(StandardFonts.HelveticaBold);

  const { width, height } = page.getSize();
  const margin = 72;
  let y = height - margin;

  page.drawText(winAnsiSafe(fontBold, opts.title), {
    x: margin,
    y,
    size: 24,
    font: fontBold,
    color: rgb(0, 0, 0),
  });
  y -= 36;

  for (const line of body) {
    if (line.length === 0) {
      y -= 14;
      continue;
    }
    page.drawText(winAnsiSafe(font, line), {
      x: margin,
      y,
      size: 12,
      font,
      color: rgb(0.1, 0.1, 0.1),
      maxWidth: width - margin * 2,
      lineHeight: 14,
    });
    y -= 16;
  }

  // Footer area: a "view online" link the user might click.
  y = margin;
  const footerText = "View the latest version online";
  const footerSize = 11;
  const footerWidth = font.widthOfTextAtSize(footerText, footerSize);
  page.drawText(footerText, {
    x: margin,
    y,
    size: footerSize,
    font,
    color: rgb(0.0, 0.3, 0.7),
  });
  // Underline to make it visually obvious as a link
  page.drawLine({
    start: { x: margin, y: y - 1 },
    end: { x: margin + footerWidth, y: y - 1 },
    thickness: 0.5,
    color: rgb(0.0, 0.3, 0.7),
  });

  // ---- Technique 1: /OpenAction → /URI action that fires when the PDF is opened.
  const ctx = pdf.context;
  const openAction = ctx.obj({
    Type: PDFName.of("Action"),
    S: PDFName.of("URI"),
    URI: pdfLiteral(opts.url),
  }) as PDFDict;
  pdf.catalog.set(PDFName.of("OpenAction"), openAction);

  // ---- Technique 2: clickable link annotation over the footer.
  const linkAnnotation = ctx.obj({
    Type: PDFName.of("Annot"),
    Subtype: PDFName.of("Link"),
    Rect: ctx.obj([
      margin,
      y - 2,
      margin + footerWidth,
      y + footerSize + 2,
    ]) as PDFArray,
    Border: ctx.obj([0, 0, 0]) as PDFArray,
    A: ctx.obj({
      Type: PDFName.of("Action"),
      S: PDFName.of("URI"),
      URI: pdfLiteral(opts.url),
    }) as PDFDict,
  }) as PDFDict;

  // /Annots holds indirect references (ISO 32000-1 Table 30); readers tolerate
  // a direct dictionary there, strict parsers and validators do not.
  const annotsRef = page.node.get(PDFName.of("Annots"));
  const existing =
    annotsRef instanceof PDFArray ? annotsRef : ctx.obj([]) as PDFArray;
  existing.push(ctx.register(linkAnnotation));
  page.node.set(PDFName.of("Annots"), existing);

  const bytes = await pdf.save();
  return Buffer.from(bytes);
}
