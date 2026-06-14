import { describe, expect, it } from "vitest";
import {
  escapeCode,
  escapeMarkdown,
  escapeSlack,
  safeDisplayUrl,
} from "../src/escape";

describe("escapeSlack", () => {
  it("neutralizes <url|label> link injection", () => {
    expect(escapeSlack("<https://evil.example|click>")).toBe(
      "&lt;https://evil.example|click&gt;",
    );
  });
});

describe("escapeMarkdown", () => {
  it("neutralizes a Teams markdown-link breakout", () => {
    expect(escapeMarkdown(")[VERIFY ACCOUNT](https://phish.example)")).toBe(
      "\\)\\[VERIFY ACCOUNT\\]\\(https://phish.example\\)",
    );
  });
});

describe("escapeCode", () => {
  it("removes backticks", () => {
    expect(escapeCode("a`b")).toBe("aʼb");
  });
});

describe("safeDisplayUrl", () => {
  it("drops the attacker-controlled query string", () => {
    expect(
      safeDisplayUrl(
        "https://edge.example/c/AAA?x=)[VERIFY](https://phish.example)",
      ),
    ).toBe("https://edge.example/c/AAA");
  });
  it("returns empty string for an unparseable URL", () => {
    expect(safeDisplayUrl("not a url")).toBe("");
  });
});
