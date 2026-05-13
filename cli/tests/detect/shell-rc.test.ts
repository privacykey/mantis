import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  shellHookFileDetector,
  shellRcDetector,
} from "../../src/commands/detect/detectors/shell-rc.js";
import type { DetectorContext } from "../../src/commands/detect/types.js";
import { cleanHome, stageHome } from "./fixtures.js";

function ctx(home: string): DetectorContext {
  return { scope: "user", homeDir: home, platform: "linux" };
}

describe("shellRcDetector", () => {
  let home: string;
  afterEach(() => {
    if (home) cleanHome(home);
  });

  it("returns no findings on a clean home", async () => {
    home = stageHome({
      ".bashrc": "# nothing to see here\nexport PATH=$PATH:/usr/local/bin\n",
    });
    const r = await shellRcDetector.run(ctx(home));
    expect(r.findings).toEqual([]);
  });

  it("detects `source ~/.mantis.sh` in .zshrc as confirmed", async () => {
    home = stageHome({
      ".zshrc": "export PATH=/usr/bin\nsource ~/.mantis.sh\nfoo=bar\n",
    });
    const r = await shellRcDetector.run(ctx(home));
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]).toMatchObject({
      kind: "shell-rc",
      severity: "confirmed",
      line: 2,
    });
    expect(r.findings[0]!.summary).toContain(".zshrc");
    expect(r.findings[0]!.summary).toContain(".mantis.sh");
  });

  it("detects legacy `source ~/.canary.sh` too", async () => {
    home = stageHome({ ".bashrc": "source ~/.canary.sh\n" });
    const r = await shellRcDetector.run(ctx(home));
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]!.severity).toBe("confirmed");
    expect(r.findings[0]!.summary).toContain(".canary");
  });

  it("detects inline X-Mantis-Source curl snippet pasted into rc", async () => {
    home = stageHome({
      ".bashrc": [
        "curl -fsS \\",
        '  -H "X-Mantis-Source: shell" \\',
        '  -H "X-Mantis-User: $USER" \\',
        '  "https://mantis.example.com/c/abc12345"',
      ].join("\n"),
    });
    const r = await shellRcDetector.run(ctx(home));
    // Two findings: the X-Mantis-Source line, plus the URL on line 4 picked up
    // by the suspicious-URL fallback because it's on a different line.
    const confirmed = r.findings.filter((f) => f.severity === "confirmed");
    expect(confirmed.length).toBeGreaterThanOrEqual(1);
    expect(confirmed[0]!.kind).toBe("shell-rc");
    expect(confirmed[0]!.source).toBe("shell");
  });

  it("flags a /c/<id> URL on its own as suspicious (not confirmed)", async () => {
    home = stageHome({
      ".zshrc": "# https://evil.example.com/c/abc12345\n",
    });
    const r = await shellRcDetector.run(ctx(home));
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]).toMatchObject({
      kind: "url-pattern",
      severity: "suspicious",
      url: "https://evil.example.com/c/abc12345",
    });
  });

  it("doesn't double-count a URL on the same line as a confirmed source", async () => {
    home = stageHome({
      ".zshrc": "source ~/.mantis.sh # https://evil.example.com/c/abc12345\n",
    });
    const r = await shellRcDetector.run(ctx(home));
    // Only the confirmed source line; not also a suspicious URL on the same line.
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]!.severity).toBe("confirmed");
  });

  it("handles missing rc files quietly", async () => {
    home = stageHome({}); // no rc files at all
    const r = await shellRcDetector.run(ctx(home));
    expect(r.findings).toEqual([]);
  });

  it("ignores `source` of an unrelated file", async () => {
    home = stageHome({ ".zshrc": "source ~/.nvm/nvm.sh\nsource /etc/zshenv\n" });
    const r = await shellRcDetector.run(ctx(home));
    expect(r.findings).toEqual([]);
  });
});

describe("shellHookFileDetector", () => {
  let home: string;
  afterEach(() => {
    if (home) cleanHome(home);
  });

  it("finds ~/.mantis.sh and extracts the URL", async () => {
    home = stageHome({
      ".mantis.sh":
        'curl -H "X-Mantis-Source: shell" "https://mantis.example.com/c/abc12345"\n',
    });
    const r = await shellHookFileDetector.run(ctx(home));
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]).toMatchObject({
      kind: "shell-hook",
      severity: "confirmed",
      url: "https://mantis.example.com/c/abc12345",
      source: "shell",
    });
    expect(r.findings[0]!.removeHint).toContain("rm");
  });

  it("finds legacy ~/.canary.sh", async () => {
    home = stageHome({ ".canary.sh": "# old install" });
    const r = await shellHookFileDetector.run(ctx(home));
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]!.path).toContain(".canary.sh");
  });

  it("flags ~/.wakeup only when it looks mantis-related", async () => {
    home = stageHome({
      ".wakeup": "# sleepwatcher hook — wake the speakers\nplay tone.wav\n",
    });
    const r1 = await shellHookFileDetector.run(ctx(home));
    expect(r1.findings).toEqual([]);

    cleanHome(home);
    home = stageHome({
      ".wakeup":
        '#!/bin/sh\ncurl -H "X-Mantis-Source: macos-wake" "https://x.example.com/c/abcdef12"\n',
    });
    const r2 = await shellHookFileDetector.run(ctx(home));
    expect(r2.findings).toHaveLength(1);
    expect(r2.findings[0]!.source).toBe("macos-wake");
  });

  it("returns no findings when no hook files exist", async () => {
    home = stageHome({});
    const r = await shellHookFileDetector.run(ctx(home));
    expect(r.findings).toEqual([]);
  });
});
