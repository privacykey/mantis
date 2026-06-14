import { describe, expect, it } from "vitest";
import { xmlEscape } from "@/lib/docs/util";
import { generateIcs } from "@/lib/docs/ics";
import { generateVcf } from "@/lib/docs/vcf";

describe("xmlEscape (OOXML/SVG well-formedness)", () => {
  it("escapes the five XML metacharacters", () => {
    expect(xmlEscape(`<a> & "x" 'y'`)).toBe(
      "&lt;a&gt; &amp; &quot;x&quot; &apos;y&apos;",
    );
  });

  it("strips a NUL control byte that is illegal in XML 1.0", () => {
    expect(xmlEscape("a\x00b")).toBe("ab");
  });

  it("strips a BEL (\\x07) control byte", () => {
    expect(xmlEscape("a\x07b")).toBe("ab");
  });

  it("strips DEL (\\x7F)", () => {
    expect(xmlEscape("a\x7Fb")).toBe("ab");
  });

  it("preserves tab, LF, and CR — the control chars XML 1.0 permits", () => {
    expect(xmlEscape("a\tb\nc\rd")).toBe("a\tb\nc\rd");
  });

  it("strips control bytes while still escaping metacharacters", () => {
    expect(xmlEscape("<\x00\x1f>")).toBe("&lt;&gt;");
  });
});

describe("icsEscape (ICS property-line injection)", () => {
  it("neutralizes a lone \\r so the memo cannot inject a property line", async () => {
    const buf = await generateIcs({
      title: "Demo\rINJECTED:evil",
      url: "https://example.com/c/abc123",
    });
    const text = buf.toString("utf8");

    // No bare CR survives — every \r in the output is a structural CRLF.
    expect(/\r(?!\n)/.test(text)).toBe(false);
    // The injected token is folded into the SUMMARY value as a literal \n,
    // not promoted to its own property line.
    expect(text).toContain("SUMMARY:Demo\\nINJECTED:evil");
    expect(text.split("\r\n")).not.toContain("INJECTED:evil");
  });
});

describe("vcfEscape (vCard property-line injection)", () => {
  it("neutralizes a lone \\r so the memo cannot inject a property line", async () => {
    const buf = await generateVcf({
      title: "Demo\rINJECTED:evil",
      url: "https://example.com/c/abc123",
    });
    const text = buf.toString("utf8");

    expect(/\r(?!\n)/.test(text)).toBe(false);
    expect(text).toContain("FN:Demo\\nINJECTED:evil");
    expect(text.split("\r\n")).not.toContain("INJECTED:evil");
  });
});
