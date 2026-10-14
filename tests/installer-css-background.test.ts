import { afterEach, describe, expect, it, vi } from "vitest";
import { INSTALLER_META, buildInstaller } from "@mantis/core/installers";

// The css-background installer hides the trigger URL behind CSS hex escapes.
// What a browser requests is the *decoded* url(), so the only thing that
// matters is that decoding gives back the input, for every random choice of
// which letters to escape.

/**
 * Decode the body of a CSS string per CSS Syntax 3: §4.3.5 (consume a string
 * token) and §4.3.7 (consume an escaped code point). A backslash followed by
 * one to six hex digits is that code point, and a single whitespace directly
 * after the digits belongs to the escape.
 */
function decodeCssString(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== "\\") {
      out += s[i];
      continue;
    }
    let hex = "";
    while (hex.length < 6 && /[0-9a-fA-F]/.test(s[i + 1] ?? "")) hex += s[++i];
    if (!hex) {
      // Backslash-newline is a line continuation; any other escaped
      // character stands for itself.
      const next = s[++i] ?? "";
      if (next === "\r" && s[i + 1] === "\n") i++;
      else if (!/[\n\r\f]/.test(next)) out += next;
      continue;
    }
    if (s[i + 1] === "\r" && s[i + 2] === "\n") i += 2;
    else if (/[ \t\n\r\f]/.test(s[i + 1] ?? "")) i++;
    const n = parseInt(hex, 16);
    out +=
      n === 0 || (n >= 0xd800 && n <= 0xdfff) || n > 0x10ffff
        ? "\uFFFD"
        : String.fromCodePoint(n);
  }
  return out;
}

/** Small deterministic PRNG so a failure reproduces. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function urlBody(content: string): string {
  const m = content.match(/url\('([^']*)'\)/);
  expect(m, "no url('…') in the generated CSS").toBeTruthy();
  return m![1]!;
}

const input = { keyId: "00000000-0000-0000-0000-000000000000", memo: "m" };

const URLS = [
  "https://mantis.example.com/c/AbCdEf2345",
  "https://mantis.tail0a1b2.ts.net/c/xKq7RzWm9P",
  "http://localhost:3000/c/abcdef0123456789",
  // mantis-edge sealed URL: a long base64url blob, dense in hex digits.
  "https://edge.example.workers.dev/t/dGhpcyBpcyBhIHNlYWxlZCBibG9iIGFiY2RlZjAxMjM0NTY3ODlBQkNERUZhYmNkZWYwMTIzNDU2Nzg5-_aBcDeF09",
];

afterEach(() => {
  vi.restoreAllMocks();
});

describe("css-background installer", () => {
  it("the test decoder itself follows the CSS escape rules", () => {
    // Terminated by a space, or padded to six digits: both decode to "m".
    expect(decodeCssString("\\6d antis")).toBe("mantis");
    expect(decodeCssString("\\00006dantis")).toBe("mantis");
    // The bug: a short escape absorbs the hex digits that follow it.
    expect(decodeCssString("\\6dantis")).toBe("\u06dantis");
    expect(decodeCssString("A\\62CdEf2345")).toBe("A\uFFFD2345");
    // Six digits, then whitespace: the whitespace is still swallowed.
    expect(decodeCssString("\\000061 b")).toBe("ab");
  });

  it.each(URLS)("every generated snippet decodes back to %s", (url) => {
    vi.spyOn(Math, "random").mockImplementation(seeded(0xc0ffee));
    let escaped = 0;
    for (let k = 0; k < 500; k++) {
      const { content } = buildInstaller("css-background", { ...input, url });
      const raw = urlBody(content);
      if (raw !== url) escaped++;
      expect(decodeCssString(raw)).toBe(url);
    }
    // The property is only meaningful if escapes are actually being emitted.
    expect(escaped).toBeGreaterThan(450);
  });

  it.each(URLS)("decodes back to %s when every letter is escaped", (url) => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const raw = urlBody(buildInstaller("css-background", { ...input, url }).content);
    // Worst case for absorption: no lowercase letter is left outside an escape.
    expect(raw.replace(/\\[0-9a-f]{6}/g, "")).not.toMatch(/[a-z]/);
    expect(decodeCssString(raw)).toBe(url);
  });

  it("pads every escape to exactly six hex digits", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const raw = urlBody(
      buildInstaller("css-background", { ...input, url: URLS[0]! }).content,
    );
    // What a CSS tokenizer takes as the escape: up to six hex digits.
    const escapes = raw.match(/\\[0-9a-fA-F]{0,6}/g) ?? [];
    expect(escapes.length).toBeGreaterThan(10);
    for (const e of escapes) expect(e).toMatch(/^\\0000[0-9a-f]{2}$/);
  });

  it("never lets an escape swallow whitespace that follows it", () => {
    // Not a valid URL, but the guarantee is "decodes to the input", and
    // whitespace after a six-digit escape is still consumed by the escape.
    vi.spyOn(Math, "random").mockReturnValue(0);
    const url = "https://mantis.example.com/c/abc def\tghi";
    const raw = urlBody(buildInstaller("css-background", { ...input, url }).content);
    expect(decodeCssString(raw)).toBe(url);
  });

  it("describes the own-site exclusion that exists, not a Referer filter", () => {
    const out = buildInstaller("css-background", { ...input, url: URLS[0]! });
    for (const text of [
      out.notes!,
      out.description,
      out.content,
      INSTALLER_META["css-background"].description,
    ]) {
      expect(text).not.toMatch(/Filter notifications by Referer/i);
      expect(text).not.toMatch(/distinguish/i);
      expect(text).not.toMatch(/identically/i);
      expect(text).toContain("self_origins");
    }
    // The limits of the exclusion are spelled out for the operator.
    expect(out.notes).toMatch(/no-referrer/);
    expect(out.notes).toMatch(/same-origin/);
    expect(out.notes).toMatch(/hot-links your stylesheet/);
    expect(out.notes).toMatch(/not detected/);
  });
});
