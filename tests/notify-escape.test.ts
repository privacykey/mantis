import { describe, expect, it } from "vitest";
import { escapeCode, escapeMarkdown, escapeSlack } from "@/lib/notify/escape";

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
