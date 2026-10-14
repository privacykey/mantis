import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const exec = promisify(execFile);
const helper = fileURLToPath(new URL("../bin/mantis-iot-helper.js", import.meta.url));
let dir;
let fileLink;
let directoryLink;

beforeEach(async () => {
  // Resolve platform aliases such as /var -> /private/var so the control path
  // is canonical; the explicitly created symlinks reproduce the same failure
  // on every supported platform.
  dir = await realpath(await mkdtemp(join(tmpdir(), "mantis-iot-entrypoint-")));
  fileLink = join(dir, "helper-link.js");
  directoryLink = join(dir, "linked-bin");
  await symlink(helper, fileLink);
  await symlink(dirname(helper), directoryLink, "dir");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function run(args, options = {}) {
  return exec(process.execPath, args, {
    cwd: dir,
    timeout: 5_000,
    env: { ...process.env, NODE_OPTIONS: "", MANTIS_IOT_CONFIG: "" },
    ...options,
  });
}

describe("helper CLI entrypoint", () => {
  for (const [name, path] of [
    ["canonical file", () => helper],
    ["symlinked file", () => fileLink],
    ["symlinked directory", () => join(directoryLink, "mantis-iot-helper.js")],
  ]) {
    it(`prints help when executed through a ${name}`, async () => {
      const result = await run([path(), "--help"]);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /mantis-iot-helper\n\nUsage:/);
      assert.doesNotMatch(result.stderr, /watching/);
    });
  }

  it("executes the configured one-shot tick once through a symlink", async () => {
    const commands = join(dir, "commands");
    const calls = join(dir, "neighbor-calls.txt");
    const config = join(dir, "config.json");
    await mkdir(commands);
    // Fake the local neighbor tools rather than probing the test machine's LAN.
    const stub = `#!${process.execPath}\n` +
      `const fs = require("node:fs");\n` +
      `fs.appendFileSync(${JSON.stringify(calls)}, "scan\\n");\n` +
      `console.log(process.argv.includes("-j") ? '[{"dst":"192.0.2.10","lladdr":"02:00:00:00:00:10","dev":"test0","state":"REACHABLE"}]' : '? (192.0.2.10) at 02:00:00:00:00:10 on test0');\n`;
    for (const command of ["ip", "arp"]) {
      await writeFile(join(commands, command), stub, { mode: 0o755 });
    }
    await writeFile(config, JSON.stringify({
      devices: [{ name: "test-device", ip: "192.0.2.10", allowed: [{ days: [] }], mantis_url: "https://mantis.example/c/test" }],
    }));
    const result = await run([fileLink, "--config", config, "--once", "--dry-run"], {
      env: { ...process.env, NODE_OPTIONS: "", MANTIS_IOT_CONFIG: "", PATH: commands },
    });
    assert.match(result.stderr, /watching 1 devices, 0 logs/);
    assert.equal((result.stderr.match(/dry-run fire unexpected-online test-device/g) ?? []).length, 1);
    assert.equal(await readFile(calls, "utf8"), "scan\n");
  });

  it("does not start the CLI when imported through a symlink", async () => {
    const importer = join(dir, "importer.mjs");
    await writeFile(importer, `import { main, createState } from ${JSON.stringify(pathToFileURL(fileLink).href)};\n` +
      `console.log(typeof main, createState().firedAt.size);\n`);
    // CLI-like arguments must not make an imported library execute main().
    const result = await run([importer, "--help", "--config", "missing.json", "--once"]);
    assert.equal(result.stdout, "function 0\n");
    assert.equal(result.stderr, "");
  });
});
