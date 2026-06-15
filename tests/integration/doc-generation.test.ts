import { describe, it, expect, vi } from "vitest";
import JSZip from "jszip";

// E2E-17 — A hostile memo that round-trips through Postgres still downloads as
// well-formed OOXML / sanitized ICS+VCF via the real /download route (d69aad96).
//   - OOXML (docx/xlsx/pptx): xmlEscape strips XML-illegal control bytes and
//     escapes metachars, so the parts stay parseable.
//   - ICS/VCF: a lone CR in the memo is normalized so it can't break out of the
//     property value and inject a new property line.
// (NUL can't be stored in a Postgres text column at all, so the storable illegal
// control bytes — BEL/VT/FF/DEL — are the realistic OOXML threat.)

vi.mock("@/lib/log", () => ({
  log: { info() {}, warn() {}, error() {}, debug() {}, fatal() {}, trace() {} },
}));

import { GET as download } from "@/app/api/keys/[id]/download/route";
import { seedApiKey, seedCanaryKey, buildJsonRequest, ctxParams } from "./_harness";

// BEL, VT, FF, DEL — storable in PG text, illegal in XML 1.0. Built at runtime so
// no raw control bytes live in this source file.
const OOXML_CTRL = String.fromCharCode(7, 11, 12, 127);
const OOXML_MEMO = `MEMOPROBE<x>&"${OOXML_CTRL} END`;
// A lone CR (no following LF) plus a property-injection attempt.
const ICS_MEMO = `MEMOPROBE${String.fromCharCode(13)}INJECTED:evil;,END`;

function hasIllegalXmlChar(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const n = s.charCodeAt(i);
    if (n <= 8 || n === 11 || n === 12 || (n >= 14 && n <= 31) || n === 127) {
      return true;
    }
  }
  return false;
}

async function downloadFormat(bearer: string, id: string, format: string): Promise<Response> {
  return download(
    buildJsonRequest(`/api/keys/${id}/download?format=${format}`, { bearer }),
    ctxParams({ id }),
  );
}

describe("E2E-17 hostile-memo document generation", () => {
  it.each(["docx", "xlsx", "pptx"])(
    "%s: every XML part is escaped and free of XML-illegal control chars",
    async (format) => {
      const owner = await seedApiKey();
      const key = await seedCanaryKey(owner.row.id, { memo: OOXML_MEMO });

      const res = await downloadFormat(owner.plaintext, key.id, format);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("openxmlformats");

      const zip = await JSZip.loadAsync(Buffer.from(await res.arrayBuffer()));
      const xmlParts = Object.keys(zip.files).filter((n) => n.endsWith(".xml"));
      expect(xmlParts.length).toBeGreaterThan(0);

      let sawEscapedMemo = false;
      for (const part of xmlParts) {
        const xml = await zip.file(part)!.async("string");
        expect(hasIllegalXmlChar(xml)).toBe(false); // control bytes stripped
        expect(xml).not.toContain("MEMOPROBE<x>"); // raw metachars never present
        if (xml.includes("MEMOPROBE&lt;x&gt;")) sawEscapedMemo = true;
      }
      expect(sawEscapedMemo).toBe(true); // memo present, just escaped
    },
  );

  it.each([
    ["ics", "text/calendar"],
    ["vcf", "text/vcard"],
  ])("%s: a lone CR is normalized and cannot inject a new property line", async (format, mime) => {
    const owner = await seedApiKey();
    const key = await seedCanaryKey(owner.row.id, { memo: ICS_MEMO });

    const res = await downloadFormat(owner.plaintext, key.id, format);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain(mime);

    const text = await res.text();
    // No lone CR survives (only CRLF line terminators remain).
    expect(/\r(?!\n)/.test(text)).toBe(false);
    // The injected "INJECTED:evil" is folded into the value, not its own line.
    const lines = text.split("\r\n");
    expect(lines.some((l) => l.startsWith("INJECTED:"))).toBe(false);
    expect(text).toContain("MEMOPROBE"); // memo content still present
  });
});
