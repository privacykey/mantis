import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mintCmd } from "../src/commands/edge.js";
import { setJsonMode } from "../src/lib/out.js";

afterEach(() => { setJsonMode(false); vi.restoreAllMocks(); });
describe("chained edge mint JSON output", () => {
  it.each([false, true])("emits one result with recoverable installer data (file=%s)", async (writeFile) => {
    const dir = await mkdtemp(join(tmpdir(), "mantis-edge-mint-"));
    const output: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => { output.push(String(chunk)); return true; });
    setJsonMode(true);
    try {
      await mintCmd({
        worker: "https://edge.example.com", webhook: "https://hooks.example.com/notify",
        key: Buffer.alloc(32, 7).toString("base64url"), install: "shell",
        ...(writeFile ? { out: join(dir, "mantis.sh") } : {}),
      });
      const result = JSON.parse(output.join(""));
      expect(output.join("").trim().split("\n")).toHaveLength(1);
      expect(result.url).toContain("/c/");
      expect(result.installer.type).toBe("shell");
      const content = writeFile ? await readFile(result.installer.written_to, "utf8") : result.installer.content;
      expect(content).toContain(result.url);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
