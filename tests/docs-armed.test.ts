import { describe, expect, it, vi } from "vitest";
import JSZip from "jszip";
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFRawStream,
  PDFRef,
  PDFString,
  decodePDFRawStream,
} from "pdf-lib";

// Record what the label generator asks the QR encoder to encode (the image
// itself can't be read back without a QR decoder), then encode as normal.
const qrPayloads = vi.hoisted(() => [] as string[]);
vi.mock("qrcode", async (importOriginal) => {
  const actual = await importOriginal<typeof import("qrcode")>();
  const real = (actual as unknown as { default: typeof import("qrcode") }).default ?? actual;
  const toBuffer = (text: string, ...rest: unknown[]) => {
    qrPayloads.push(text);
    return (real.toBuffer as (...a: unknown[]) => Promise<Buffer>)(text, ...rest);
  };
  return { ...actual, default: { ...real, toBuffer }, toBuffer };
});

import { generateFile } from "@/lib/docs";

// Regressions that a generated bait is actually ARMED: the trigger URL sits in
// the element that makes the consuming application fetch it. Escaping and
// preset-metadata tests alone would pass with an inert file.

const URL = "https://mantis.example.com/c/aBcD1234Xy";
const TITLE = "Q4 payroll";

const OOXML: Array<["docx" | "xlsx" | "pptx", string, string]> = [
  ["docx", "word/_rels/document.xml.rels", "word/document.xml"],
  ["xlsx", "xl/drawings/_rels/drawing1.xml.rels", "xl/drawings/drawing1.xml"],
  ["pptx", "ppt/slides/_rels/slide1.xml.rels", "ppt/slides/slide1.xml"],
];

function uriOf(dict: PDFDict): string {
  const uri = dict.lookup(PDFName.of("URI"));
  if (!(uri instanceof PDFString) && !(uri instanceof PDFHexString)) {
    throw new Error("URI entry is not a string");
  }
  return uri.decodeText();
}

async function pageText(pdfBytes: Buffer): Promise<string> {
  const pdf = await PDFDocument.load(pdfBytes);
  let out = "";
  for (const [, obj] of pdf.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream)) continue;
    let decoded: string;
    try {
      decoded = Buffer.from(decodePDFRawStream(obj).decode()).toString("latin1");
    } catch {
      continue; // image data etc.
    }
    // drawText writes <hex> Tj operands in the font's single-byte encoding.
    for (const m of decoded.matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g)) {
      out += `${Buffer.from(m[1]!, "hex").toString("latin1")}\n`;
    }
  }
  return out;
}

describe("OOXML baits carry the trigger URL in their one external picture", () => {
  it.each(OOXML)("%s", async (format, relsPart, bodyPart) => {
    const zip = await JSZip.loadAsync(
      await generateFile(format, { title: TITLE, url: `${URL}?a=1&b=2` }),
    );
    const rels = await zip.file(relsPart)!.async("string");
    const external = [...rels.matchAll(/<Relationship\b[^>]*TargetMode="External"[^>]*\/>/g)];
    expect(external).toHaveLength(1);
    // XML-escaped in the part, so it decodes back to the exact URL.
    expect(external[0]![0]).toContain(`Id="rIdMantis"`);
    expect(external[0]![0]).toContain(`Target="${URL}?a=1&amp;b=2"`);

    // …and the picture that makes Office fetch it links (not embeds) that rel.
    const body = await zip.file(bodyPart)!.async("string");
    expect(body).toMatch(/<a:blip\b[^>]*r:link="rIdMantis"/);
    expect(body).not.toMatch(/r:embed=/);
  });
});

describe("PDF bait", () => {
  it("fires through /OpenAction and a link annotation, both carrying the URL", async () => {
    const pdf = await PDFDocument.load(
      await generateFile("pdf", { title: TITLE, url: URL }),
    );

    const open = pdf.catalog.lookup(PDFName.of("OpenAction"), PDFDict);
    expect(open.lookup(PDFName.of("S"))).toBe(PDFName.of("URI"));
    expect(uriOf(open)).toBe(URL);

    const annots = pdf.getPage(0).node.lookup(PDFName.of("Annots"), PDFArray);
    expect(annots.size()).toBe(1);
    // ISO 32000-1 Table 30: annotations are indirect references.
    expect(annots.get(0)).toBeInstanceOf(PDFRef);
    const link = annots.lookup(0, PDFDict);
    expect(link.lookup(PDFName.of("Subtype"))).toBe(PDFName.of("Link"));
    expect(uriOf(link.lookup(PDFName.of("A"), PDFDict))).toBe(URL);
  });

  it("keeps a URL with PDF string delimiters intact", async () => {
    // "(", ")" and "\" are structural inside a PDF literal string.
    const url = "https://mantis.example.com/c/aBcD1234Xy?p=a)b(c\\d";
    const pdf = await PDFDocument.load(
      await generateFile("pdf", { title: TITLE, url }),
    );
    expect(uriOf(pdf.catalog.lookup(PDFName.of("OpenAction"), PDFDict))).toBe(url);
    const annots = pdf.getPage(0).node.lookup(PDFName.of("Annots"), PDFArray);
    expect(uriOf(annots.lookup(0, PDFDict).lookup(PDFName.of("A"), PDFDict))).toBe(url);
  });

  it("does not draw the URL on the page", async () => {
    const text = await pageText(await generateFile("pdf", { title: TITLE, url: URL }));
    expect(text).toContain("View the latest version online");
    expect(text).not.toContain("mantis.example.com");
  });

  it.each(["pdf", "nfc-label"] as const)(
    "%s: a memo outside WinAnsi still generates",
    async (format) => {
      // Helvetica cannot encode these; pdf-lib throws, which used to surface
      // as a 500 on the download. Unsupported characters draw as "?".
      const title = "給与 2026 отчёт 😀\tQ4\nfinal";
      const bytes = await generateFile(format, { title, url: URL });
      const pdf = await PDFDocument.load(bytes);
      expect(pdf.getPageCount()).toBe(1);
      // The metadata title keeps the original text.
      expect(pdf.getTitle()).toContain("給与 2026 отчёт 😀");
      const text = await pageText(bytes);
      expect(text).toContain("?? 2026 ????? ? Q4 final");
    },
  );
});

describe("NFC label", () => {
  it("tags the URL to write as src=nfc and the QR code as src=qr", async () => {
    qrPayloads.length = 0;
    const bytes = await generateFile("nfc-label", { title: TITLE, url: URL });

    expect(qrPayloads).toEqual([`${URL}?src=qr`]);
    const text = await pageText(bytes);
    expect(text).toContain(`URL to write:  ${URL}?src=nfc`);
    // The caption under the QR stays the plain URL (what a person would type).
    expect(text.split("\n")).toContain(URL);
  });
});
