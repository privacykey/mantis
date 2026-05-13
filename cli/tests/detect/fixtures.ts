import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Stages a throwaway $HOME with the given files, returns the absolute path.
 * Caller must rmSync() it when done.
 */
export function stageHome(files: Record<string, string>): string {
  const home = mkdtempSync(join(tmpdir(), "mantis-detect-test-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(home, rel);
    const dir = abs.split("/").slice(0, -1).join("/");
    if (dir) mkdirSync(dir, { recursive: true });
    writeFileSync(abs, content);
  }
  return home;
}

export function cleanHome(path: string): void {
  rmSync(path, { recursive: true, force: true });
}
