import { describe, expect, it } from "vitest";
import {
  clipEscaped,
  escapeCode,
  escapeMarkdown,
  escapeSlack,
  truncate,
} from "@/lib/notify/escape";

describe("escapeSlack", () => {
  it("neutralizes <url|label> link and <!here> mention injection", () => {
    expect(escapeSlack("<https://evil.example|click> <!here>")).toBe(
      "&lt;https://evil.example|click&gt; &lt;!here&gt;",
    );
  });
  it("escapes ampersands", () => {
    expect(escapeSlack("a & b")).toBe("a &amp; b");
  });
});

describe("escapeMarkdown", () => {
  it("neutralizes masked [label](url) links", () => {
    expect(escapeMarkdown("[click me](https://evil.example)")).toBe(
      "\\[click me\\]\\(https://evil.example\\)",
    );
  });
  it("escapes formatting and spoiler metachars", () => {
    expect(escapeMarkdown("**x** ~y~ ||z||")).toBe(
      "\\*\\*x\\*\\* \\~y\\~ \\|\\|z\\|\\|",
    );
  });
  it("leaves IPs and user agents readable", () => {
    expect(escapeMarkdown("10.0.0.1 Mozilla/5.0")).toBe("10.0.0.1 Mozilla/5.0");
  });
});

describe("escapeCode", () => {
  it("removes backticks that would break out of a code span", () => {
    expect(escapeCode("rm -rf /`; curl evil`")).toBe("rm -rf /ʼ; curl evilʼ");
  });
});

// Chat platforms reject a whole alert over one oversized field, and escaping
// grows a value, so the budget is applied to the ESCAPED text.
describe("clipEscaped", () => {
  it("returns the escaped value untouched when it fits", () => {
    expect(clipEscaped("a & b", 20, escapeSlack)).toBe("a &amp; b");
  });

  it("never exceeds the budget, however much escaping grows the value", () => {
    // 401 raw ampersands escape to 2005 characters: over Slack's 2000.
    const out = clipEscaped("&".repeat(401), 256, escapeSlack);
    expect(out.length).toBeLessThanOrEqual(256);
    expect(out.endsWith("…")).toBe(true);
    // 600 underscores double under markdown escaping: over Discord's 1024.
    expect(clipEscaped("_".repeat(600), 256, escapeMarkdown).length).toBeLessThanOrEqual(256);
  });

  it("does not cut a Slack entity in half", () => {
    for (let max = 2; max <= 40; max++) {
      const out = clipEscaped("<&>".repeat(20), max, escapeSlack);
      expect(out.length).toBeLessThanOrEqual(max);
      // Whatever survives is whole entities followed by the ellipsis.
      expect(out).toMatch(/^(?:&lt;|&amp;|&gt;)*…$/);
    }
  });

  it("does not leave a dangling markdown backslash", () => {
    for (let max = 2; max <= 40; max++) {
      const out = clipEscaped("[x](y)".repeat(20), max, escapeMarkdown);
      expect(out.length).toBeLessThanOrEqual(max);
      // A lone trailing backslash would escape the ellipsis instead.
      expect(out).toMatch(/^(?:\\[[\]()]|[xy])*…$/);
    }
  });

  it("does not split a surrogate pair", () => {
    expect(clipEscaped("🪤".repeat(10), 6, escapeSlack)).toBe("🪤🪤…");
  });
});

describe("truncate", () => {
  it("caps literal text and marks the cut", () => {
    expect(truncate("abcdef", 4)).toBe("abc…");
    expect(truncate("abc", 4)).toBe("abc");
  });
  it("does not split a surrogate pair", () => {
    // Cutting after three code units would keep half of the second emoji.
    expect(truncate("🪤🪤🪤", 4)).toBe("🪤…");
  });
});
