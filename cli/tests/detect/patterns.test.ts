import { describe, expect, it } from "vitest";
import { scanContentForPatterns } from "../../src/commands/detect/patterns.js";

describe("scanContentForPatterns", () => {
  it("matches a bare mantis trigger URL", () => {
    const m = scanContentForPatterns("hit https://mantis.example.com/c/abc12345 nope");
    expect(m).toHaveLength(1);
    expect(m[0]!.pattern.id).toBe("mantis-trigger");
    expect(m[0]!.text).toBe("https://mantis.example.com/c/abc12345");
    expect(m[0]!.line).toBe(1);
  });

  it("rates a bare mantis URL as suspicious (not confirmed)", () => {
    const m = scanContentForPatterns("https://x.example.com/c/abcdefg1");
    expect(m[0]!.pattern.severity).toBe("suspicious");
  });

  it("matches canarytokens.com URLs as confirmed", () => {
    const m = scanContentForPatterns(
      "see https://canarytokens.com/articles/abcd/contact.php for more",
    );
    expect(m).toHaveLength(1);
    expect(m[0]!.pattern.id).toBe("canarytokens-url");
    expect(m[0]!.pattern.severity).toBe("confirmed");
  });

  it("matches canarytokens.org and canarytokens.net URLs", () => {
    const a = scanContentForPatterns("https://canarytokens.org/feedback/abc");
    expect(a[0]!.pattern.id).toBe("canarytokens-url");
    const b = scanContentForPatterns("https://blah.canarytokens.net/something");
    expect(b[0]!.pattern.id).toBe("canarytokens-url");
  });

  it("matches a DNS-style canarytokens.net hostname", () => {
    const m = scanContentForPatterns("nslookup abcd1234.canarytokens.net");
    // Two patterns hit this — url-pattern needs http://, so just dns matches.
    const dnsMatches = m.filter((x) => x.pattern.id === "canarytokens-dns");
    expect(dnsMatches).toHaveLength(1);
    expect(dnsMatches[0]!.text).toBe("abcd1234.canarytokens.net");
  });

  it("matches an email canary", () => {
    const m = scanContentForPatterns("alerts: bobtoken+a1@canarytokens.com");
    const emailMatch = m.find((x) => x.pattern.id === "canarytokens-email");
    expect(emailMatch?.text).toBe("bobtoken+a1@canarytokens.com");
  });

  it("matches a Thinkst Canary appliance hostname", () => {
    const m = scanContentForPatterns("canary at sales.canary.tools");
    expect(m.find((x) => x.pattern.id === "thinkst-canary-tools")?.text).toBe(
      "sales.canary.tools",
    );
  });

  it("ignores ordinary URLs", () => {
    const m = scanContentForPatterns("https://example.com/api/users/42");
    expect(m).toEqual([]);
  });

  it("computes line numbers correctly", () => {
    const content = "line 1\nline 2\nfetch https://x.com/c/abcdefgh\nline 4";
    const m = scanContentForPatterns(content);
    expect(m[0]!.line).toBe(3);
  });

  it("collapses repeats of the same URL on the same line into one finding", () => {
    // Reporting the same URL twice on the same line is noise — the user
    // already sees the line. Different URLs on the same line → two findings.
    const sameTwice = scanContentForPatterns(
      "https://canarytokens.com/x https://canarytokens.com/x",
    );
    expect(sameTwice).toHaveLength(1);

    const twoDifferent = scanContentForPatterns(
      "https://canarytokens.com/x https://canarytokens.com/y",
    );
    expect(twoDifferent).toHaveLength(2);

    const acrossLines = scanContentForPatterns(
      "https://canarytokens.com/x\nhttps://canarytokens.com/x",
    );
    expect(acrossLines).toHaveLength(2);
  });

  it("handles multi-MB content without blowing up", () => {
    const big = "filler\n".repeat(100_000) + "https://canarytokens.com/y";
    const m = scanContentForPatterns(big);
    expect(m).toHaveLength(1);
    expect(m[0]!.line).toBe(100_001);
  });
});
