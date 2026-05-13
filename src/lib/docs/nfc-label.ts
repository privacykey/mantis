import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import QRCode from "qrcode";
import type { DocOptions } from "./util";

/**
 * Printable NFC sticker label PDF — designed to be cut out and stuck on/near
 * an NFC tag. Layout on US Letter:
 *
 *   - Large QR code (fallback for non-NFC devices)
 *   - The URL text below the QR
 *   - The memo at the top
 *   - "Tap or scan" instruction
 *
 * Unlike the canary PDF (pdf.ts), this label does NOT contain any auto-firing
 * mechanism — it's intended to be printed onto paper, where /OpenAction has
 * no meaning. The trigger fires when someone scans the QR or taps the NFC
 * tag (which the operator writes separately).
 */
export async function generateNfcLabel(opts: DocOptions): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(`${opts.title} — NFC label`);
  pdf.setProducer("mantis");
  pdf.setCreator("mantis");
  pdf.setCreationDate(new Date());

  const page = pdf.addPage([612, 792]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdf.embedFont(StandardFonts.HelveticaBold);

  const { width, height } = page.getSize();
  const margin = 72;

  // Title
  const titleSize = 20;
  const titleWidth = fontBold.widthOfTextAtSize(opts.title, titleSize);
  page.drawText(opts.title, {
    x: (width - titleWidth) / 2,
    y: height - margin - titleSize,
    size: titleSize,
    font: fontBold,
    color: rgb(0, 0, 0),
  });

  // Subtitle
  const subtitle = "Tap with an NFC-enabled phone, or scan the QR code";
  const subSize = 11;
  const subWidth = font.widthOfTextAtSize(subtitle, subSize);
  page.drawText(subtitle, {
    x: (width - subWidth) / 2,
    y: height - margin - titleSize - 22,
    size: subSize,
    font,
    color: rgb(0.3, 0.3, 0.3),
  });

  // QR code (PNG bytes -> embedded image)
  const qrPngBuf = await QRCode.toBuffer(opts.url, {
    errorCorrectionLevel: "M",
    width: 600,
    margin: 1,
    color: { dark: "#000000", light: "#ffffff" },
  });
  const qrImage = await pdf.embedPng(qrPngBuf);
  const qrSize = 360;
  const qrX = (width - qrSize) / 2;
  const qrY = height - margin - titleSize - 60 - qrSize;
  page.drawImage(qrImage, { x: qrX, y: qrY, width: qrSize, height: qrSize });

  // URL text below QR — small enough that long URLs still fit
  const urlSize = 9;
  const urlWidth = font.widthOfTextAtSize(opts.url, urlSize);
  page.drawText(opts.url, {
    x: Math.max(margin, (width - urlWidth) / 2),
    y: qrY - 22,
    size: urlSize,
    font,
    color: rgb(0.2, 0.2, 0.2),
  });

  // Cut marks around a sticker-sized region (90 × 90 mm-ish at the QR)
  const padding = 16;
  drawCutMark(page, qrX - padding, qrY + qrSize + padding);
  drawCutMark(page, qrX + qrSize + padding, qrY + qrSize + padding);
  drawCutMark(page, qrX - padding, qrY - padding);
  drawCutMark(page, qrX + qrSize + padding, qrY - padding);

  // Footer notes
  const lines = [
    "How to use:",
    "  1. Buy a blank NFC tag (NTAG213/215/216) — cheap, widely available.",
    "  2. Use any NFC-write app (e.g. NFC Tools on Android/iOS) to write a URL record.",
    "     URL to write:  " + opts.url,
    "  3. Stick the tag behind this paper, or stick the paper as a QR fallback.",
    "  4. Anyone who taps the tag (NFC) or scans the QR fires the canary.",
  ];
  let footerY = margin + lines.length * 14;
  for (const ln of lines) {
    page.drawText(ln, {
      x: margin,
      y: footerY,
      size: 9,
      font,
      color: rgb(0.25, 0.25, 0.25),
    });
    footerY -= 14;
  }

  const bytes = await pdf.save();
  return Buffer.from(bytes);
}

function drawCutMark(
  page: ReturnType<PDFDocument["addPage"]>,
  x: number,
  y: number,
): void {
  const len = 8;
  page.drawLine({
    start: { x: x - len, y },
    end: { x: x + len, y },
    thickness: 0.5,
    color: rgb(0.5, 0.5, 0.5),
  });
  page.drawLine({
    start: { x, y: y - len },
    end: { x, y: y + len },
    thickness: 0.5,
    color: rgb(0.5, 0.5, 0.5),
  });
}
