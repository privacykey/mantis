import { afterEach, describe, expect, it } from "vitest";
import { walkText } from "../../src/commands/detect/walk.js";
import { cleanHome, stageHome } from "./fixtures.js";

describe("walkText", () => {
  let home: string;
  afterEach(() => {
    if (home) cleanHome(home);
  });

  it("yields text files under the root", async () => {
    home = stageHome({
      "notes.md": "hello",
      "sub/dir/script.sh": "echo hi",
      "binary.png": "PNG\x00binary",
    });
    const seen: string[] = [];
    const stats = await walkText({
      roots: [home],
      onFile: ({ path }) => {
        seen.push(path);
      },
    });
    expect(seen.some((p) => p.endsWith("notes.md"))).toBe(true);
    expect(seen.some((p) => p.endsWith("script.sh"))).toBe(true);
    expect(seen.some((p) => p.endsWith("binary.png"))).toBe(false);
    expect(stats.scanned).toBe(2);
  });

  it("skips node_modules and .git directories", async () => {
    home = stageHome({
      "kept.md": "kept",
      "node_modules/foo/bar.js": "skipped",
      ".git/config": "[core]",
    });
    const seen: string[] = [];
    await walkText({
      roots: [home],
      onFile: ({ path }) => {
        seen.push(path);
      },
    });
    expect(seen.some((p) => p.endsWith("kept.md"))).toBe(true);
    expect(seen.some((p) => p.includes("node_modules"))).toBe(false);
    expect(seen.some((p) => p.includes(".git"))).toBe(false);
  });

  it("descends into .config/.local/.ssh (selective dot-dir allowlist)", async () => {
    // Use files with recognized text extensions inside each allowlisted
    // dotdir — the walker descends, but only picks up files it can scan.
    home = stageHome({
      ".config/app/config.toml": "[section]",
      ".local/share/x.txt": "x",
      ".ssh/notes.md": "host notes",
      ".hidden-thing/leak.txt": "ignored",
    });
    const seen: string[] = [];
    await walkText({
      roots: [home],
      onFile: ({ path }) => {
        seen.push(path);
      },
    });
    expect(seen.some((p) => p.includes(".config"))).toBe(true);
    expect(seen.some((p) => p.includes(".local"))).toBe(true);
    expect(seen.some((p) => p.includes(".ssh"))).toBe(true);
    expect(seen.some((p) => p.includes(".hidden-thing"))).toBe(false);
  });

  it("truncates files larger than the per-file cap", async () => {
    const big = "X".repeat(2 * 1024 * 1024); // 2 MiB
    home = stageHome({ "huge.md": big });
    const sizes: number[] = [];
    const stats = await walkText({
      roots: [home],
      onFile: ({ content }) => {
        sizes.push(content.length);
      },
    });
    expect(sizes[0]).toBe(1024 * 1024);
    expect(stats.truncated).toBe(true);
  });

  it("respects fileLimit", async () => {
    home = stageHome({
      "a.md": "a",
      "b.md": "b",
      "c.md": "c",
    });
    const stats = await walkText({
      roots: [home],
      fileLimit: 2,
      onFile: () => {},
    });
    expect(stats.scanned).toBe(2);
    expect(stats.reachedLimit).toBe(true);
  });

  it("recognizes well-known extension-less dotfiles", async () => {
    home = stageHome({
      ".bashrc": "alias ll=ls",
      ".vimrc": "set number",
      "Dockerfile": "FROM alpine",
      "randomfile": "no ext, not allowlisted",
    });
    const seen: string[] = [];
    await walkText({
      roots: [home],
      onFile: ({ path }) => {
        seen.push(path);
      },
    });
    expect(seen.some((p) => p.endsWith(".bashrc"))).toBe(true);
    expect(seen.some((p) => p.endsWith(".vimrc"))).toBe(true);
    expect(seen.some((p) => p.endsWith("Dockerfile"))).toBe(true);
    expect(seen.some((p) => p.endsWith("randomfile"))).toBe(false);
  });
});
