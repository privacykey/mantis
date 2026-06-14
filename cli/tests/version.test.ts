import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { CLI_VERSION } from "../src/version.js";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
  readFileSync(join(here, "..", "package.json"), "utf8"),
) as { version: string };

describe("CLI_VERSION", () => {
  // version.ts is generated from package.json by scripts/gen-version.mjs.
  // If this fails, run `node scripts/gen-version.mjs` (or `pnpm build`).
  it("matches the version in package.json", () => {
    expect(CLI_VERSION).toBe(pkg.version);
  });
});
