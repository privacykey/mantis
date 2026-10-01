import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const helper = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packager = join(helper, "scripts", "package-homeassistant.mjs");

test("packages from another cwd into a portable, runnable add-on folder", async () => {
  const temporary = await realpath(await mkdtemp(join(tmpdir(), "mantis-ha-package-test-")));
  try {
    const output = join(temporary, "addon");
    const result = spawnSync(process.execPath, [packager, output], { cwd: temporary, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual((await readdir(output)).sort(), ["Dockerfile", "README.md", "bin", "config.yaml", "package.json", "run.sh"]);
    assert.equal(await readFile(join(output, "bin", "mantis-iot-helper.js"), "utf8"), await readFile(join(helper, "bin", "mantis-iot-helper.js"), "utf8"));
    const runnable = spawnSync(process.execPath, [join(output, "bin", "mantis-iot-helper.js"), "--help"], { cwd: temporary, encoding: "utf8" });
    assert.equal(runnable.status, 0, runnable.stderr);
    assert.match(runnable.stderr, /--config/);
    // All image COPY inputs must actually exist in the generated context.
    const dockerfile = await readFile(join(output, "Dockerfile"), "utf8");
    for (const match of dockerfile.matchAll(/^COPY\s+(\S+)\s+/gm)) {
      await readdir(output).then((names) => assert.ok(names.includes(match[1])));
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("refuses to overwrite either populated or empty existing directories", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "mantis-ha-preserve-test-"));
  try {
    const empty = join(temporary, "empty");
    const populated = join(temporary, "populated");
    await mkdir(empty);
    await mkdir(populated);
    await writeFile(join(populated, "user-data.txt"), "keep this");
    for (const output of [empty, populated]) {
      const result = spawnSync(process.execPath, [packager, output], { encoding: "utf8" });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /existing files were preserved/);
    }
    assert.deepEqual(await readdir(empty), []);
    assert.equal(await readFile(join(populated, "user-data.txt"), "utf8"), "keep this");
    assert.deepEqual(await readdir(populated), ["user-data.txt"]);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("requires exactly one output argument", () => {
  for (const arguments_ of [[], ["unused", "extra"]]) {
    const result = spawnSync(process.execPath, [packager, ...arguments_], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Usage:/);
  }
});
