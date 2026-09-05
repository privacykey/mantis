import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hitsCmd } from "../src/commands/hits.js";
import { watchCmd } from "../src/commands/watch.js";
import { ExitCode, setJsonMode } from "../src/lib/out.js";
import { withClient } from "../src/lib/runner.js";

vi.mock("../src/lib/runner.js", () => ({
  withClient: vi.fn(async () => undefined),
}));

describe.each([
  ["watch", (interval: string) => watchCmd({ interval })],
  ["hits --follow", (interval: string) => hitsCmd("last", { follow: true, interval })],
] as const)("%s interval validation", (_name, run) => {
  beforeEach(() => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("__test_exit__");
    });
  });

  afterEach(() => {
    setJsonMode(false);
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it.each(["abc", "NaN", "Infinity", "2147484", "1e308", "", " ", "0", "-1"])(
    "rejects %j before creating an API client",
    async (interval) => {
      await expect(run(interval)).rejects.toThrow("__test_exit__");
      expect(process.exit).toHaveBeenCalledWith(ExitCode.Usage);
      expect(process.stderr.write).toHaveBeenCalledWith(expect.stringContaining("--interval"));
      expect(withClient).not.toHaveBeenCalled();
    },
  );

  it("keeps errors machine-readable in JSON mode", async () => {
    setJsonMode(true);
    await expect(run("abc")).rejects.toThrow("__test_exit__");
    const output = vi.mocked(process.stderr.write).mock.calls[0]![0];
    expect(JSON.parse(String(output))).toEqual({
      error: expect.stringContaining("--interval"),
    });
    expect(process.exit).toHaveBeenCalledWith(ExitCode.Usage);
    expect(withClient).not.toHaveBeenCalled();
  });
});
