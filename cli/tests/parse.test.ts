import { afterEach, describe, expect, it, vi } from "vitest";
import { ExitCode } from "../src/lib/out.js";
import { parseIntervalMs } from "../src/lib/parse.js";

describe("parseIntervalMs", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([
    [undefined, 5, 5000],
    [undefined, 3, 3000],
    ["1", 5, 1000],
    ["2.5", 5, 2500],
    [" 2.5 ", 5, 2500],
    ["0.1", 5, 1000],
    ["2147483.647", 5, 2_147_483_647],
  ] as const)("parses %j with fallback %i as %i ms", (raw, fallback, expected) => {
    expect(parseIntervalMs(raw, fallback)).toBe(expected);
  });

  it.each(["2147483.648", "1e308"])("rejects timer overflow from %j", (raw) => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("__test_exit__");
    });
    expect(() => parseIntervalMs(raw, 5)).toThrow("__test_exit__");
    expect(process.exit).toHaveBeenCalledWith(ExitCode.Usage);
    expect(process.stderr.write).toHaveBeenCalledWith(
      expect.stringContaining("--interval must be at most 2147483.647 seconds"),
    );
  });
});
