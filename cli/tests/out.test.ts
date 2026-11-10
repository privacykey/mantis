import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { c, cutMiddle, formatError, formatTime, setColorMode, truncate, visibleLength } from "../src/lib/out.js";

describe("formatTime", () => {
  it("returns - for null", () => {
    expect(formatTime(null)).toBe("-");
  });

  it("renders recent past as a bare duration", () => {
    expect(formatTime(new Date(Date.now() - 5 * 60_000).toISOString())).toBe("5m");
    expect(formatTime(new Date(Date.now() - 2 * 3_600_000).toISOString())).toBe("2h");
  });

  it("renders the future as 'in <duration>', not a negative number", () => {
    expect(formatTime(new Date(Date.now() + 5 * 60_000).toISOString())).toBe("in 5m");
  });

  it("renders the current instant as 'now'", () => {
    expect(formatTime(new Date().toISOString())).toBe("now");
  });
});

describe("truncate", () => {
  beforeEach(() => {
    vi.stubEnv("TERM", "xterm-256color");
    vi.stubEnv("LC_ALL", "en_US.UTF-8");
    vi.stubEnv("MANTIS_ASCII", "");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("returns short strings unchanged", () => {
    expect(truncate("hello", 10)).toBe("hello");
  });

  it("truncates with a unicode ellipsis", () => {
    expect(truncate("hello world", 5)).toBe("hell…");
  });

  it("preserves ANSI color and re-appends a reset when cut mid-span", () => {
    const out = truncate("\x1b[31mhello world\x1b[0m", 5);
    expect(out.startsWith("\x1b[31m")).toBe(true);
    expect(out.endsWith("\x1b[0m")).toBe(true);
    expect(out.replace(/\x1b\[[0-9;]*m/g, "")).toBe("hell…");
  });

  it("uses an ASCII ellipsis when unicode is disabled", () => {
    vi.stubEnv("MANTIS_ASCII", "1");
    expect(truncate("hello world", 6)).toBe("hel...");
    expect(truncate("hello world", 2)).toBe("..");
  });

  it("keeps a grapheme together across an SGR style boundary", () => {
    expect(truncate("e\x1b[31m\u0301abc", 2)).toBe("e\x1b[31m\u0301…\x1b[0m");
  });
});

describe("setColorMode", () => {
  afterEach(() => setColorMode("auto"));

  it("never disables color regardless of TTY", () => {
    setColorMode("never");
    expect(c.red("x")).toBe("x");
  });

  it("always wraps in ANSI regardless of TTY", () => {
    setColorMode("always");
    expect(c.red("x")).toBe("\x1b[31mx\x1b[0m");
  });
});

describe("cutMiddle", () => {
  beforeEach(() => {
    vi.stubEnv("TERM", "xterm-256color");
    vi.stubEnv("LC_ALL", "en_US.UTF-8");
    vi.stubEnv("MANTIS_ASCII", "");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("keeps both ends of a memo on word edges", () => {
    const memo = "AWS creds honeytoken: ~/.aws/credentials on ci-runner-07";
    expect(cutMiddle(memo, 24)).toBe("AWS creds … ci-runner-07");
  });

  it("never runs past the width it is given", () => {
    for (const s of ["ci@ci-runner-07", "Slackbot-LinkExpanding 1.0", "Cloned-site detector: login.acme-corp.example"]) {
      for (const n of [8, 12, 14, 20]) expect(cutMiddle(s, n).length).toBeLessThanOrEqual(n);
    }
  });

  it("fits wide text and preserves complete emoji in ASCII mode", () => {
    vi.stubEnv("MANTIS_ASCII", "1");
    expect(visibleLength(cutMiddle("界".repeat(20), 10))).toBeLessThanOrEqual(10);
    expect(cutMiddle("a😀xx😀b", 6)).toBe("a...b");
    const family = "👩‍👩‍👧‍👦";
    expect(cutMiddle(`a${family}xxxxx${family}b`, 9)).toBe(`a${family}...${family}b`);
  });

  it("leaves text that fits alone, and keeps a one-span style", () => {
    expect(cutMiddle("short", 10)).toBe("short");
    const bold = cutMiddle("\x1b[1mAWS creds honeytoken: ~/.aws/credentials on ci-runner-07\x1b[0m", 24);
    expect(bold).toBe("\x1b[1mAWS creds … ci-runner-07\x1b[0m");
  });
});

describe("formatError", () => {
  beforeEach(() => {
    vi.stubEnv("LC_ALL", "en_US.UTF-8");
    vi.stubEnv("MANTIS_ASCII", "");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("prints the next step as an indented arrow line, like an empty state", () => {
    setColorMode("never");
    const out = formatError("no key matches prefix beef", "Run `mantis list` to see configured keys.");
    expect(out.split("\n")[1]).toMatch(/^ {2}(→|->) Run `?mantis list`? to see configured keys\.$/);
  });
});
