import { describe, expect, it } from "vitest";
import {
  escapeCode,
  escapeMarkdown,
  escapeSlack,
  safeDisplayUrl,
  triggerLabel,
  truncateEscaped,
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

describe("truncateEscaped", () => {
  it("returns short values unchanged", () => {
    expect(truncateEscaped("a &amp; b", 9, "slack")).toBe("a &amp; b");
    expect(truncateEscaped("", 5, "markdown")).toBe("");
  });

  it("never exceeds the budget, ellipsis included", () => {
    for (const style of ["slack", "markdown", "plain"] as const) {
      for (let max = 1; max <= 40; max++) {
        const out = truncateEscaped("x".repeat(100), max, style);
        expect(out.length).toBe(max);
        expect(out.endsWith("…")).toBe(true);
      }
    }
  });

  it("never cuts a Slack entity in half, wherever the cut falls", () => {
    const escaped = escapeSlack("ab&cd<ef>gh&&<<>>ij&");
    for (let max = 1; max < escaped.length; max++) {
      const out = truncateEscaped(escaped, max, "slack");
      expect(out.length, `max=${max}`).toBeLessThanOrEqual(max);
      expect(out, `max=${max}`).not.toMatch(/&(?!amp;|lt;|gt;)/);
      // What is kept is a prefix of the escaped text.
      expect(escaped.startsWith(out.slice(0, -1)), `max=${max}`).toBe(true);
    }
    expect(truncateEscaped("12&amp;34", 6, "slack")).toBe("12…");
    expect(truncateEscaped("12&amp;34", 8, "slack")).toBe("12&amp;…");
  });

  it("never leaves a markdown escape without its character", () => {
    const escaped = escapeMarkdown("a_b*c\\d[e](f)__**\\\\~|>`z");
    for (let max = 1; max < escaped.length; max++) {
      const out = truncateEscaped(escaped, max, "markdown");
      expect(out.length, `max=${max}`).toBeLessThanOrEqual(max);
      const trailing = /(\\*)…$/.exec(out)![1]!;
      expect(trailing.length % 2, `max=${max}: ${out}`).toBe(0);
    }
    expect(truncateEscaped("ab\\_cd", 4, "markdown")).toBe("ab…");
    expect(truncateEscaped("ab\\_cd", 5, "markdown")).toBe("ab\\_…");
  });

  it("never splits a surrogate pair", () => {
    const text = "ab😀cd😀ef";
    for (let max = 1; max < text.length; max++) {
      for (const style of ["slack", "markdown", "plain"] as const) {
        expect(truncateEscaped(text, max, style).isWellFormed(), `max=${max}`).toBe(true);
      }
    }
  });
});

describe("triggerLabel", () => {
  const blob = `AQ${"k".repeat(60)}`;

  it("keeps the host and only a short prefix of the sealed blob", () => {
    expect(triggerLabel(`https://edge.example/c/${blob}?x=1#y`)).toEqual({
      id: "AQkkkkkkkk…",
      host: "edge.example",
    });
  });

  it("never returns enough of the blob to rebuild the trigger URL", () => {
    const { id } = triggerLabel(`https://edge.example/c/${blob}`);
    expect(id.length).toBeLessThan(blob.length / 2);
    expect(id).not.toContain(blob);
  });

  it("does not echo a path that is not an edge trigger", () => {
    expect(triggerLabel("https://edge.example/c/a/b").id).toBe("unknown");
    expect(triggerLabel("https://edge.example/c/<script>").id).toBe("unknown");
    expect(triggerLabel("not a url")).toEqual({ id: "unknown", host: "unknown" });
  });
});
