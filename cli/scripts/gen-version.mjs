#!/usr/bin/env node
//
// Generate src/version.ts from package.json so `mantis --version` and the
// doctor CLI-vs-server check never drift from the published version.
//
// Why codegen instead of a runtime read: the release binaries are built with
// `bun build --compile`, which bundles everything into a single executable —
// there is no adjacent package.json to read at runtime. Stamping the constant
// at build time keeps `tsx` (dev), `node dist/index.js` (npm bin), and the
// compiled binary all reporting the same version.
//
// Run automatically by the `dev`, `build`, and `build:bin` scripts; safe to
// run by hand after bumping the version in package.json.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgPath = join(here, "..", "package.json");
const outPath = join(here, "..", "src", "version.ts");

const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
const version = pkg.version;
if (typeof version !== "string" || version.length === 0) {
  console.error(`gen-version: no "version" field in ${pkgPath}`);
  process.exit(1);
}

const body = `// Generated from package.json by scripts/gen-version.mjs — do not edit by hand.
export const CLI_VERSION = ${JSON.stringify(version)};
`;

writeFileSync(outPath, body);
