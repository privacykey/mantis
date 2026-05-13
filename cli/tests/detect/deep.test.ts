import { afterEach, describe, expect, it } from "vitest";
import { deepDetector } from "../../src/commands/detect/detectors/deep.js";
import type { DetectorContext } from "../../src/commands/detect/types.js";
import { cleanHome, stageHome } from "./fixtures.js";

function ctx(home: string, deep = true): DetectorContext {
  return { scope: "user", homeDir: home, platform: "linux", deep };
}

describe("deepDetector", () => {
  let home: string;
  afterEach(() => {
    if (home) cleanHome(home);
  });

  it("is not applicable without --deep", () => {
    expect(deepDetector.applicable(ctx("/", false))).toBe(false);
    expect(deepDetector.applicable(ctx("/", true))).toBe(true);
  });

  it("finds a canarytokens.com URL planted in a markdown note", async () => {
    home = stageHome({
      "Documents/notes.md": "TODO: investigate https://canarytokens.com/test/abc/contact.php",
    });
    const r = await deepDetector.run(ctx(home));
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]).toMatchObject({
      kind: "canarytokens-url",
      severity: "confirmed",
      vendor: "canarytokens.com (Thinkst)",
    });
    expect(r.findings[0]!.url).toContain("canarytokens.com");
  });

  it("finds a mantis URL anywhere in $HOME", async () => {
    home = stageHome({
      "stuff/random.txt": "ping https://attacker.example.com/c/abc12345",
    });
    const r = await deepDetector.run(ctx(home));
    const hit = r.findings.find((f) => f.kind === "mantis-trigger");
    expect(hit).toBeDefined();
    expect(hit!.severity).toBe("suspicious"); // bare URL alone = suspicious
  });

  it("finds canary.tools (Thinkst appliance) hostname", async () => {
    home = stageHome({
      ".bashrc": "# alerts at corp.canary.tools",
    });
    const r = await deepDetector.run(ctx(home));
    expect(r.findings.some((f) => f.kind === "thinkst-canary-tools")).toBe(true);
  });

  it("finds canarytokens DNS subdomain", async () => {
    home = stageHome({
      "scripts/probe.sh": "dig +short xyz.canarytokens.net",
    });
    const r = await deepDetector.run(ctx(home));
    expect(r.findings.some((f) => f.kind === "canarytokens-dns")).toBe(true);
  });

  it("returns no findings on a clean home", async () => {
    home = stageHome({
      "notes.md": "this is a normal note about cats",
      "scripts/setup.sh": "#!/bin/sh\nexport PATH=$PATH:/usr/local",
    });
    const r = await deepDetector.run(ctx(home));
    expect(r.findings).toEqual([]);
  });

  it("skips node_modules even when contents would match", async () => {
    home = stageHome({
      "node_modules/foo/lib/x.js":
        "url: 'https://canarytokens.com/articles/abc'",
    });
    const r = await deepDetector.run(ctx(home));
    expect(r.findings).toEqual([]);
  });
});
