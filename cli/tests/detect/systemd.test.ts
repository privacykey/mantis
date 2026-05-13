import { afterEach, describe, expect, it } from "vitest";
import {
  networkManagerDetector,
  systemdDetector,
} from "../../src/commands/detect/detectors/systemd.js";
import type { DetectorContext } from "../../src/commands/detect/types.js";
import { cleanHome, stageHome } from "./fixtures.js";

function ctx(home: string): DetectorContext {
  return { scope: "user", homeDir: home, platform: "linux" };
}

const SAMPLE_UNIT = `[Unit]
Description=Mantis ping on boot
After=network-online.target

[Service]
Type=oneshot
ExecStart=/bin/sh -c '/usr/bin/curl -fsS -H "X-Mantis-Source: linux-boot" "https://mantis.example.com/c/abc12345"'

[Install]
WantedBy=multi-user.target
`;

describe("systemdDetector", () => {
  let home: string;
  afterEach(() => {
    if (home) cleanHome(home);
  });

  it("finds a user-scope mantis-*.service", async () => {
    home = stageHome({
      ".config/systemd/user/mantis-abc12345.service": SAMPLE_UNIT,
    });
    const r = await systemdDetector.run(ctx(home));
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]).toMatchObject({
      kind: "systemd",
      severity: "confirmed",
      url: "https://mantis.example.com/c/abc12345",
      source: "linux-boot",
    });
    expect(r.findings[0]!.removeHint).toContain("systemctl --user disable");
  });

  it("finds a legacy canary-wake-*.service", async () => {
    home = stageHome({
      ".config/systemd/user/canary-wake-xyz67890.service": SAMPLE_UNIT,
    });
    const r = await systemdDetector.run(ctx(home));
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]!.summary).toContain("canary-wake-xyz67890.service");
  });

  it("ignores non-mantis units", async () => {
    home = stageHome({
      ".config/systemd/user/syncthing.service": "[Unit]\nDescription=Syncthing\n",
    });
    const r = await systemdDetector.run(ctx(home));
    expect(r.findings).toEqual([]);
  });

  it("is not applicable on macOS/Windows", () => {
    expect(
      systemdDetector.applicable({ scope: "user", homeDir: "/", platform: "darwin" }),
    ).toBe(false);
    expect(
      systemdDetector.applicable({ scope: "user", homeDir: "/", platform: "win32" }),
    ).toBe(false);
  });
});

describe("networkManagerDetector", () => {
  it("is only applicable on linux + system scope", () => {
    expect(
      networkManagerDetector.applicable({
        scope: "user",
        homeDir: "/",
        platform: "linux",
      }),
    ).toBe(false);
    expect(
      networkManagerDetector.applicable({
        scope: "system",
        homeDir: "/",
        platform: "linux",
      }),
    ).toBe(true);
    expect(
      networkManagerDetector.applicable({
        scope: "system",
        homeDir: "/",
        platform: "darwin",
      }),
    ).toBe(false);
  });
});
