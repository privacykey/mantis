import { describe, expect, it } from "vitest";
import { renderHuman, renderJson } from "../../src/commands/detect/render.js";
import type { Finding, ScanSummary } from "../../src/commands/detect/types.js";

function summary(findings: Finding[]): ScanSummary {
  return {
    scope: "user",
    scanned: ["shell-rc", "launchd"],
    permissionDenied: [],
    errors: [],
    findings,
  };
}

describe("renderHuman", () => {
  it("prints the green ✓ when there are no findings", () => {
    const out = renderHuman(summary([]), { verbose: false });
    expect(out).toContain("no mantis-style artifacts detected");
    expect(out).toContain("scope:");
  });

  it("lists each finding with path/url/remove sections", () => {
    const out = renderHuman(
      summary([
        {
          kind: "shell-rc",
          severity: "confirmed",
          path: "/home/me/.zshrc",
          line: 42,
          summary: ".zshrc sources a mantis hook",
          url: "https://mantis.example.com/c/abc12345",
          removeHint: "sed -i.bak '42d' /home/me/.zshrc",
        },
      ]),
      { verbose: false },
    );
    expect(out).toContain("1 mantis-style artifact");
    expect(out).toContain("/home/me/.zshrc:42");
    expect(out).toContain("https://mantis.example.com/c/abc12345");
    expect(out).toContain("sed -i.bak");
    expect(out).toContain("If you didn't install");
  });

  it("includes 'match' only with verbose", () => {
    const f: Finding = {
      kind: "shell-rc",
      severity: "confirmed",
      path: "/home/me/.zshrc",
      line: 1,
      match: "source ~/.mantis.sh",
      summary: ".zshrc sources a mantis hook",
      removeHint: "edit it",
    };
    expect(renderHuman(summary([f]), { verbose: false })).not.toContain(
      "source ~/.mantis.sh",
    );
    expect(renderHuman(summary([f]), { verbose: true })).toContain(
      "source ~/.mantis.sh",
    );
  });

  it("sorts confirmed before suspicious", () => {
    const out = renderHuman(
      summary([
        {
          kind: "url-pattern",
          severity: "suspicious",
          path: "/home/me/.bashrc",
          summary: "suspicious URL",
          removeHint: "review manually",
        },
        {
          kind: "launchd",
          severity: "confirmed",
          path: "/home/me/Library/x.plist",
          summary: "confirmed agent",
          removeHint: "rm",
        },
      ]),
      { verbose: false },
    );
    const confirmedIdx = out.indexOf("confirmed agent");
    const suspiciousIdx = out.indexOf("suspicious URL");
    expect(confirmedIdx).toBeLessThan(suspiciousIdx);
  });
});

describe("renderJson", () => {
  it("emits valid JSON with the expected top-level shape", () => {
    const out = renderJson(
      summary([
        {
          kind: "shell-rc",
          severity: "confirmed",
          path: "/x",
          summary: "y",
          removeHint: "z",
        },
      ]),
    );
    const parsed = JSON.parse(out);
    expect(parsed).toMatchObject({
      scope: "user",
      scanned: ["shell-rc", "launchd"],
      findings: [
        {
          kind: "shell-rc",
          severity: "confirmed",
          path: "/x",
          remove_hint: "z",
        },
      ],
    });
    expect(parsed.findings[0].url).toBeNull(); // missing fields become null
  });
});
