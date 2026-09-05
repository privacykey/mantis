import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { c, formatTime, setColorMode, truncate } from "../src/lib/out.js";

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
