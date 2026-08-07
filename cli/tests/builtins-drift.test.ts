import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { BUILTIN_FORMAT_IDS } from "../src/lib/plugins/builtins.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");

// BUILTIN_FORMAT_IDS is half of what stops a plugin from claiming a built-in
// id and shadowing it (see lib/plugins/install.ts). The installer-type half is
// derived from @mantis/core and cannot drift; the format list is still
// hand-copied from the server's docs module (server-only — it pulls in
// passkit-generator, pdf-lib, …) and HAD drifted, missing every
// credential-store format. A stale entry is a silent hole in the conflict
// check, so read the server's own list and compare.

async function serverArray(
  relPath: string,
  declaration: RegExp,
): Promise<string[]> {
  const src = await readFile(resolve(repoRoot, relPath), "utf8");
  const block = src.match(declaration);
  expect(block, `could not find the declaration in ${relPath}`).toBeTruthy();
  return [...block![1]!.matchAll(/"([a-z0-9-]+)"/g)].map((m) => m[1]!);
}

describe("built-in id sets track the server", () => {
  it("covers every download format the server ships", async () => {
    const server = await serverArray(
      "src/lib/docs/index.ts",
      /export const ALL_FORMATS: FileFormat\[\] = \[([^\]]*)\]/,
    );
    expect(server.length).toBeGreaterThan(10);
    // `qr` is CLI-only — it's generated locally, never downloaded from the
    // server — so it is legitimately extra here rather than drift.
    const cliExtras = new Set(["qr"]);
    const fromServer = [...BUILTIN_FORMAT_IDS].filter((f) => !cliExtras.has(f));
    expect(fromServer.sort()).toEqual([...server].sort());
  });
});
