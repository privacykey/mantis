import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

const child = vi.hoisted(() => ({ spawn: vi.fn(), spawnSync: vi.fn() }));
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  ...child,
}));

import { windowsTaskDetector } from "../src/commands/detect/detectors/windows-task.js";
import { copyToClipboard } from "../src/lib/clipboard.js";
import { systemExe } from "../src/lib/system-exe.js";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const realPlatform = process.platform;

function asWindows(): void {
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  vi.stubEnv("SystemRoot", "C:\\Windows");
}

afterEach(() => {
  Object.defineProperty(process, "platform", { value: realPlatform, configurable: true });
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("systemExe", () => {
  const env = { SystemRoot: "D:\\WinNT" };

  it("names Windows system helpers by absolute path under System32", () => {
    expect(systemExe("schtasks", "win32", env)).toBe("D:\\WinNT\\System32\\schtasks.exe");
    expect(systemExe("rundll32.exe", "win32", env)).toBe("D:\\WinNT\\System32\\rundll32.exe");
    expect(systemExe("powershell.exe", "win32", env)).toBe(
      "D:\\WinNT\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    );
  });

  it("falls back to windir, then C:\\Windows — never to a bare name", () => {
    expect(systemExe("schtasks", "win32", { windir: "E:\\W" })).toBe("E:\\W\\System32\\schtasks.exe");
    expect(systemExe("schtasks", "win32", {})).toBe("C:\\Windows\\System32\\schtasks.exe");
  });

  it.each(["darwin", "linux"] as const)("changes nothing on %s", (platform) => {
    expect(systemExe("schtasks", platform, env)).toBe("schtasks");
    expect(systemExe("powershell.exe", platform, env)).toBe("powershell.exe");
    expect(systemExe("rundll32.exe", platform, env)).toBe("rundll32.exe");
  });
});

describe("call sites on win32", () => {
  it("clipboard launches PowerShell by absolute path", async () => {
    asWindows();
    child.spawn.mockImplementation(() => ({
      on(event: string, cb: (code: number) => void) {
        if (event === "close") queueMicrotask(() => cb(0));
        return this;
      },
      stdin: { on: () => {}, end: () => {} },
      kill: () => {},
    }));

    await expect(copyToClipboard("https://mantis.example.com/c/abc")).resolves.toBe(true);

    expect(child.spawn).toHaveBeenCalledTimes(1);
    expect(child.spawn.mock.calls[0]![0]).toBe(
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    );
  });

  it("the scheduled-task detector launches schtasks by absolute path", async () => {
    asWindows();
    child.spawnSync.mockReturnValue({ status: 0, stdout: "", stderr: "" });

    await windowsTaskDetector.run({ scope: "user", homeDir: "C:\\Users\\me", platform: "win32", deep: false });

    expect(child.spawnSync.mock.calls[0]![0]).toBe("C:\\Windows\\System32\\schtasks.exe");
  });
});

describe("source guard", () => {
  function sources(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return sources(path);
      return path.endsWith(".ts") ? [path] : [];
    });
  }

  it("no Windows system helper is spawned by bare name", () => {
    const literal = /(.{0,10})["'`](schtasks(?:\.exe)?|powershell(?:\.exe)?|rundll32(?:\.exe)?)["'`]/gi;
    const offenders: string[] = [];
    for (const file of sources(SRC)) {
      if (file.endsWith(join("lib", "system-exe.ts"))) continue;
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(literal)) {
        if (!m[1]!.endsWith("systemExe(")) offenders.push(`${relative(SRC, file)}: ${m[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
