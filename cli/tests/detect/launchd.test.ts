import { afterEach, describe, expect, it } from "vitest";
import { launchdDetector } from "../../src/commands/detect/detectors/launchd.js";
import type { DetectorContext } from "../../src/commands/detect/types.js";
import { cleanHome, stageHome } from "./fixtures.js";

function ctx(home: string): DetectorContext {
  return { scope: "user", homeDir: home, platform: "darwin" };
}

const SAMPLE_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>com.mantis.login.abc12345</string>
    <key>ProgramArguments</key>
    <array>
      <string>/bin/sh</string>
      <string>-c</string>
      <string>/usr/bin/curl -H "X-Mantis-Source: macos-login" "https://mantis.example.com/c/abc12345"</string>
    </array>
    <key>RunAtLoad</key><true/>
</dict>
</plist>`;

describe("launchdDetector", () => {
  let home: string;
  afterEach(() => {
    if (home) cleanHome(home);
  });

  it("finds a com.mantis.login.* plist", async () => {
    home = stageHome({
      "Library/LaunchAgents/com.mantis.login.abc12345.plist": SAMPLE_PLIST,
    });
    const r = await launchdDetector.run(ctx(home));
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]).toMatchObject({
      kind: "launchd",
      severity: "confirmed",
      url: "https://mantis.example.com/c/abc12345",
      source: "macos-login",
    });
    expect(r.findings[0]!.summary).toContain("login");
    expect(r.findings[0]!.removeHint).toContain("launchctl unload");
  });

  it("finds a legacy com.canary.boot.* plist", async () => {
    home = stageHome({
      "Library/LaunchAgents/com.canary.boot.xyz67890.plist": SAMPLE_PLIST.replace(
        "com.mantis.login",
        "com.canary.boot",
      ),
    });
    const r = await launchdDetector.run(ctx(home));
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]!.summary).toContain("boot");
  });

  it("ignores non-mantis plists in the same directory", async () => {
    home = stageHome({
      "Library/LaunchAgents/com.apple.somedaemon.plist": "<plist/>",
      "Library/LaunchAgents/com.user.starship.plist": "<plist/>",
    });
    const r = await launchdDetector.run(ctx(home));
    expect(r.findings).toEqual([]);
  });

  it("handles missing LaunchAgents dir quietly", async () => {
    home = stageHome({}); // no Library dir
    const r = await launchdDetector.run(ctx(home));
    expect(r.findings).toEqual([]);
    expect(r.permissionDenied).toEqual([]);
  });

  it("is not applicable on linux/windows", () => {
    expect(
      launchdDetector.applicable({ scope: "user", homeDir: "/", platform: "linux" }),
    ).toBe(false);
    expect(
      launchdDetector.applicable({ scope: "user", homeDir: "/", platform: "win32" }),
    ).toBe(false);
  });
});
