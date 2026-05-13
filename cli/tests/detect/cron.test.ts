import { describe, expect, it } from "vitest";
import { cronDetector } from "../../src/commands/detect/detectors/cron.js";

describe("cronDetector", () => {
  it("is applicable on POSIX", () => {
    expect(
      cronDetector.applicable({ scope: "user", homeDir: "/", platform: "darwin" }),
    ).toBe(true);
    expect(
      cronDetector.applicable({ scope: "user", homeDir: "/", platform: "linux" }),
    ).toBe(true);
  });

  it("is not applicable on Windows", () => {
    expect(
      cronDetector.applicable({ scope: "user", homeDir: "/", platform: "win32" }),
    ).toBe(false);
  });

  // Note: we can't easily stub spawnSync without a mocking framework — the
  // real `crontab -l` is invoked. The applicable() checks are the meaningful
  // unit-level coverage; the full path is exercised by the self-test in
  // run_in_background mode (see CLAUDE-side smoke test).
});
