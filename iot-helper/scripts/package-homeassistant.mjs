#!/usr/bin/env node
import { copyFile, cp, mkdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const helper = resolve(dirname(fileURLToPath(import.meta.url)), "..");

if (process.argv.length !== 3) {
  console.error("Usage: node iot-helper/scripts/package-homeassistant.mjs <new-output-directory>");
  process.exitCode = 1;
} else {
  const output = resolve(process.argv[2]);
  let created = false;
  try {
    // Exclusive creation protects an existing package or user files, including
    // an existing empty directory. Resolve sources independently of the cwd.
    await mkdir(output);
    created = true;
    for (const name of ["Dockerfile", "run.sh", "config.yaml", "README.md"]) {
      await copyFile(join(helper, "homeassistant-addon", name), join(output, name));
    }
    await copyFile(join(helper, "package.json"), join(output, "package.json"));
    await cp(join(helper, "bin"), join(output, "bin"), { recursive: true });
    console.log(`Home Assistant add-on packaged at ${output}`);
  } catch (error) {
    if (created) await rm(output, { recursive: true, force: true });
    console.error(error?.code === "EEXIST"
      ? "Output directory already exists. Choose a new directory; existing files were preserved."
      : `Could not package the add-on: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
