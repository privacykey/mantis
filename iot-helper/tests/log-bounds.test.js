import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { appendFile, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createState, scanLogWatcher } from "../bin/mantis-iot-helper.js";

const run = promisify(execFile);
const HELPER = fileURLToPath(new URL("../bin/mantis-iot-helper.js", import.meta.url));

const originalFetch = globalThis.fetch;
const originalError = console.error;
// cooldownMs 0 so every event is delivered and the tests can count them.
const opts = { cooldownMs: 0, dryRun: false, deliveryTimeoutMs: 50 };
const small = { chunkBytes: 1024, maxLineBytes: 256, maxBytesPerPoll: 4096, maxEventsPerPoll: 3 };
let dir;
let delivered;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mantis-iot-bounds-"));
  console.error = () => {};
  delivered = [];
  globalThis.fetch = async (_url, init) => {
    delivered.push(JSON.parse(init.body).line);
    return new Response(null, { status: 204 });
  };
});
afterEach(async () => {
  globalThis.fetch = originalFetch;
  console.error = originalError;
  await rm(dir, { recursive: true, force: true });
});

function watcherFor(path) {
  return { name: "login", path, pattern: "auth success", mantis_url: "https://mantis.example/c/token" };
}

function offsetOf(state) {
  return [...state.logOffsets.values()][0].offset;
}

function filler(bytes) {
  const line = `${"x".repeat(79)}\n`;
  return line.repeat(Math.ceil(bytes / line.length));
}

// A watcher starts at the end of an existing file; this registers it.
async function startWatching(path, state, limits = small) {
  await writeFile(path, "boot\n");
  await scanLogWatcher(watcherFor(path), state, { ...opts, logLimits: limits });
}

async function pollUntilCaughtUp(path, state, limits = small, maxPolls = 200) {
  const size = (await stat(path)).size;
  let polls = 0;
  while (offsetOf(state) < size) {
    assert.ok(++polls <= maxPolls, "scan stopped making progress");
    await scanLogWatcher(watcherFor(path), state, { ...opts, logLimits: limits });
  }
  return polls;
}

describe("log watcher bounds", () => {
  it("reads a large burst over several polls without skipping a matching line", async () => {
    const path = join(dir, "burst.log");
    const state = createState();
    await startWatching(path, state);
    const before = offsetOf(state);
    await appendFile(path, `auth success: first\n${filler(20_000)}auth success: last\n`);

    await scanLogWatcher(watcherFor(path), state, { ...opts, logLimits: small });
    // The login line at the head of the burst is alerted on the first poll…
    assert.deepEqual(delivered, ["auth success: first"]);
    // …and that poll read no more than its byte budget (plus one chunk).
    assert.ok(offsetOf(state) - before <= small.maxBytesPerPoll + small.chunkBytes);
    assert.ok(offsetOf(state) < (await stat(path)).size);

    const polls = await pollUntilCaughtUp(path, state);
    assert.ok(polls >= 3, `expected the backlog to take several polls, took ${polls}`);
    assert.deepEqual(delivered, ["auth success: first", "auth success: last"]);
  });

  it("builds a bounded number of events per poll and resumes at the next line", async () => {
    const path = join(dir, "many.log");
    const state = createState();
    await startWatching(path, state);
    const expected = Array.from({ length: 10 }, (_, i) => `auth success #${i}`);
    await appendFile(path, expected.map((line) => `${line}\nnoise\n`).join(""));

    const perPoll = [];
    for (let i = 0; i < 4; i++) {
      await scanLogWatcher(watcherFor(path), state, { ...opts, logLimits: small });
      perPoll.push(delivered.length);
    }
    assert.deepEqual(perPoll, [3, 6, 9, 10]);
    assert.deepEqual(delivered, expected);
  });

  it("does not spend the event budget on matches that are inside the cooldown", async () => {
    const path = join(dir, "cooldown.log");
    const state = createState();
    await startWatching(path, state);
    await appendFile(path, "auth success: real\n" + "auth success: repeat\n".repeat(100));
    const size = (await stat(path)).size;

    const cooling = { ...opts, cooldownMs: 900_000, logLimits: small };
    await scanLogWatcher(watcherFor(path), state, cooling);
    assert.deepEqual(delivered, ["auth success: real"]);
    // The repeats cannot alert during the cooldown, so they do not count
    // against the per-poll event cap: the next poll reads straight through.
    await scanLogWatcher(watcherFor(path), state, cooling);
    assert.equal(offsetOf(state), size);
    assert.deepEqual(delivered, ["auth success: real"]);
    assert.equal(state.pendingLogs.size, 0);
  });

  it("matches only the head of an over-long line and never re-reads its tail", async () => {
    const path = join(dir, "long.log");
    const state = createState();
    await startWatching(path, state);
    await appendFile(
      path,
      `auth success ${"A".repeat(5000)}\n` +
        `${"B".repeat(5000)} auth success too late\n` +
        "auth success: after\n",
    );
    await pollUntilCaughtUp(path, state);
    assert.equal(delivered.length, 2);
    assert.ok(delivered[0].startsWith("auth success AAAA"));
    assert.equal(Buffer.byteLength(delivered[0]), small.maxLineBytes);
    assert.equal(delivered[1], "auth success: after");
  });

  it("handles an over-long line that is still being written", async () => {
    const path = join(dir, "growing.log");
    const state = createState();
    await startWatching(path, state);
    // No line break yet, but already past the line cap: alert on the head now.
    await appendFile(path, `auth success ${"A".repeat(3000)}`);
    await scanLogWatcher(watcherFor(path), state, { ...opts, logLimits: small });
    assert.equal(delivered.length, 1);
    // The rest of that line (which itself contains the pattern) is discarded.
    await appendFile(path, `${"A".repeat(3000)} auth success tail\nauth success: next\n`);
    await pollUntilCaughtUp(path, state);
    assert.deepEqual(delivered.slice(1), ["auth success: next"]);
  });

  it("keeps a short unfinished line for the next poll", async () => {
    const path = join(dir, "partial.log");
    const state = createState();
    await startWatching(path, state);
    await appendFile(path, "noise\nauth succ");
    await scanLogWatcher(watcherFor(path), state, { ...opts, logLimits: small });
    assert.deepEqual(delivered, []);
    await appendFile(path, "ess: joined\r\n");
    await scanLogWatcher(watcherFor(path), state, { ...opts, logLimits: small });
    assert.deepEqual(delivered, ["auth success: joined"]);
  });

  it("decodes multi-byte text that straddles a read boundary", async () => {
    const path = join(dir, "utf8.log");
    const state = createState();
    await startWatching(path, state);
    // "boot\n" is 5 bytes; pad so the matching line starts a few bytes before
    // the 1024-byte chunk boundary and its accented characters cross it.
    const pad = `${"p".repeat(small.chunkBytes - 5 - 16 - 1)}\n`;
    const line = "auth success: café ünïcödé ✓";
    await appendFile(path, `${pad}${line}\n`);
    await pollUntilCaughtUp(path, state);
    assert.deepEqual(delivered, [line]);
  });

  it("retries undelivered events before reading further, without duplicates", async () => {
    const path = join(dir, "retry.log");
    const state = createState();
    await startWatching(path, state);
    await appendFile(path, `auth success: one\n${filler(3000)}auth success: two\n`);

    let fail = true;
    globalThis.fetch = async (_url, init) => {
      if (fail) return new Response(null, { status: 503 });
      delivered.push(JSON.parse(init.body).line);
      return new Response(null, { status: 204 });
    };
    await scanLogWatcher(watcherFor(path), state, { ...opts, logLimits: small });
    assert.equal(state.pendingLogs.size, 1);
    const stalledAt = offsetOf(state);
    await scanLogWatcher(watcherFor(path), state, { ...opts, logLimits: small });
    assert.equal(offsetOf(state), stalledAt, "nothing new is read while an event is undelivered");

    fail = false;
    await pollUntilCaughtUp(path, state);
    assert.deepEqual(delivered, ["auth success: one", "auth success: two"]);
    assert.equal(state.pendingLogs.size, 0);
  });

  it("delivers the login alert from a burst far larger than the heap could buffer", async () => {
    const path = join(dir, "flood.log");
    const script = `
      import { appendFile, stat, writeFile } from "node:fs/promises";
      import { pathToFileURL } from "node:url";
      const path = process.argv[1];
      const { createState, scanLogWatcher } = await import(pathToFileURL(process.argv[2]).href);
      const lines = [];
      console.error = () => {};
      globalThis.fetch = async (_url, init) => { lines.push(JSON.parse(init.body).line); return new Response(null, { status: 204 }); };
      const watcher = { name: "login", path, pattern: "auth success", mantis_url: "https://mantis.example/c/token" };
      const opts = { cooldownMs: 0, dryRun: false, deliveryTimeoutMs: 50 };
      const state = createState();
      await writeFile(path, "boot\\n");
      await scanLogWatcher(watcher, state, opts);
      const block = ("x".repeat(79) + "\\n").repeat(13108); // ~1 MiB
      await appendFile(path, "auth success: admin from 192.0.2.7\\n");
      for (let i = 0; i < 16; i++) await appendFile(path, block);
      await appendFile(path, "auth success: trailing\\n");
      const size = (await stat(path)).size;
      let polls = 0;
      while ([...state.logOffsets.values()][0].offset < size && polls++ < 50) await scanLogWatcher(watcher, state, opts);
      process.stdout.write(JSON.stringify({ lines, size, polls }));
    `;
    // The helper's defaults, in a process whose heap is smaller than what
    // buffering and splitting this delta in one piece would need. The log
    // path comes first so the helper (argv[2]) is imported, not run as main.
    const { stdout } = await run(
      process.execPath,
      ["--max-old-space-size=32", "--input-type=module", "-e", script, path, HELPER],
      { maxBuffer: 1024 * 1024 },
    );
    const result = JSON.parse(stdout);
    assert.ok(result.size > 16 * 1024 * 1024);
    assert.deepEqual(result.lines, ["auth success: admin from 192.0.2.7", "auth success: trailing"]);
  });
});
