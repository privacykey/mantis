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

  it("strips a lone high surrogate (illegal in XML 1.0 Char production)", () => {
    expect(xmlEscape("a\uD800b")).toBe("ab");
  });

  it("strips a lone low surrogate", () => {
    expect(xmlEscape("a\uDC00b")).toBe("ab");
  });

  it("preserves a valid surrogate PAIR — emoji round-trips intact", () => {
    // 😀 = U+1F600 = U+D83D U+DE00. Stripping paired surrogates would corrupt
    // legitimate emoji, so only UNPAIRED surrogates must be removed.
    const out = xmlEscape("a😀b");
    expect(out).toBe("a😀b");
    // Iterating by code point yields one scalar for the emoji — a broken pair
    // (one surrogate stripped) could not produce this.
    expect([...out]).toEqual(["a", "😀", "b"]);
    expect(out.codePointAt(1)).toBe(0x1f600);
  });

  it("strips the noncharacters U+FFFE and U+FFFF", () => {
    expect(xmlEscape("a￾b￿c")).toBe("abc");
  });

  it("strips a U+FDD0–U+FDEF noncharacter", () => {
    expect(xmlEscape("a﷐b﷯c")).toBe("abc");
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

  it("neutralizes a CRLF in the URL so it cannot inject a property line", async () => {
    const buf = await generateIcs({
      title: "Demo",
      url: "https://example.com/c/abc\r\nINJECTED:evil",
    });
    const text = buf.toString("utf8");

    // No bare CR survives — every \r in the output is a structural CRLF.
    expect(/\r(?!\n)/.test(text)).toBe(false);
    // The line break is percent-encoded inside the URI value, not promoted to
    // its own property line. Applies to both URL and ATTACH interpolations.
    expect(text).toContain("URL:https://example.com/c/abc%0D%0AINJECTED:evil");
    expect(text).toContain(
      "ATTACH;FMTTYPE=image/png:https://example.com/c/abc%0D%0AINJECTED:evil",
    );
    expect(text.split("\r\n")).not.toContain("INJECTED:evil");
  });

  it("leaves a URI value intact: no TEXT escaping of ; , or backslash", async () => {
    // RFC 5545 defines no backslash escaping for URI values; escaping them
    // would hand the calendar client a different URL, and the bait would miss.
    const url = "https://example.com/base;v=1/c/abc123?a=1,2";
    const text = (await generateIcs({ title: "Demo", url })).toString("utf8");
    expect(text).toContain(`URL:${url}\r\n`);
    expect(text).toContain(`ATTACH;FMTTYPE=image/png:${url}\r\n`);
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

  it("neutralizes a CRLF in the URL so it cannot inject a property line", async () => {
    const buf = await generateVcf({
      title: "Demo",
      url: "https://example.com/c/abc\r\nINJECTED:evil",
    });
    const text = buf.toString("utf8");

    expect(/\r(?!\n)/.test(text)).toBe(false);
    // Percent-encoded inside both the PHOTO and URL property values.
    expect(text).toContain("URL:https://example.com/c/abc%0D%0AINJECTED:evil");
    expect(text).toContain(
      "PHOTO;VALUE=URI:https://example.com/c/abc%0D%0AINJECTED:evil",
    );
    expect(text.split("\r\n")).not.toContain("INJECTED:evil");
  });

  it("leaves a URI value intact: no TEXT escaping of ; , or backslash", async () => {
    const url = "https://example.com/base;v=1/c/abc123?a=1,2";
    const text = (await generateVcf({ title: "Demo", url })).toString("utf8");
    expect(text).toContain(`URL:${url}\r\n`);
    expect(text).toContain(`PHOTO;VALUE=URI:${url}\r\n`);
  });
});
