import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import {
  createState, fireWithCooldown, isDevicePresent, parseArp,
  parseIpNeighJson, parseIpNeighText, scanLogWatcher, tick,
} from "../bin/mantis-iot-helper.js";

const originalFetch = globalThis.fetch;
const originalError = console.error;
const opts = { cooldownMs: 900_000, dryRun: false, deliveryTimeoutMs: 50 };
let dir;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mantis-iot-recovery-"));
  console.error = () => {};
});
afterEach(async () => {
  globalThis.fetch = originalFetch;
  console.error = originalError;
  await rm(dir, { recursive: true, force: true });
});

function event(state, url = "https://mantis.example/c/token") {
  return { key: "device:camera", state, url, event: "unexpected-online", source: "iot-network", device: "camera", ...opts };
}

describe("delivery recovery", () => {
  it("does not consume cooldown on failed HTTP or network delivery", async () => {
    const state = createState();
    const results = [new Response(null, { status: 503 }), new Error("offline"), new Response(null, { status: 204 })];
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      const next = results.shift();
      if (next instanceof Error) throw next;
      return next;
    };
    assert.equal(await fireWithCooldown(event(state)), false);
    assert.equal(state.firedAt.size, 0);
    assert.equal(await fireWithCooldown(event(state)), false);
    assert.equal(state.firedAt.size, 0);
    assert.equal(await fireWithCooldown(event(state)), true);
    assert.equal(await fireWithCooldown(event(state)), true);
    assert.equal(calls, 3);
  });

  it("bounds a hanging request and permits the next attempt", async () => {
    const server = createServer(() => {});
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${server.address().port}/c/token`;
    const state = createState();
    const started = Date.now();
    try {
      assert.equal(await fireWithCooldown(event(state, url)), false);
      assert.ok(Date.now() - started < 1500, "delivery should finish promptly after its deadline");
      assert.equal(state.firedAt.size, 0);
      globalThis.fetch = async () => new Response(null, { status: 204 });
      assert.equal(await fireWithCooldown(event(state, url)), true);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("accepts a redirect trigger without following its destination", async () => {
    const state = createState();
    globalThis.fetch = async (_url, init) => {
      assert.equal(init.redirect, "manual");
      return new Response(null, { status: 302, headers: { location: "https://unreachable.example" } });
    };
    assert.equal(await fireWithCooldown(event(state)), true);
    assert.equal(state.firedAt.size, 1);
  });

  it("does not wait for a streaming response body after trigger acceptance", async () => {
    const server = createServer((_req, res) => { res.writeHead(200); res.write("accepted"); });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${server.address().port}/c/token`;
    try {
      const started = Date.now();
      assert.equal(await fireWithCooldown({ ...event(createState(), url), deliveryTimeoutMs: 500 }), true);
      assert.ok(Date.now() - started < 1500);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("fires the same named device independently to multiple targets", async () => {
    const urls = [];
    globalThis.fetch = async (url) => { urls.push(url); return new Response(null, { status: 204 }); };
    const config = { devices: ["one", "two"].map((target) => ({
      name: "camera", ip: "192.168.1.50", mantis_url: `https://${target}.example/c/token`,
      allowed: [{ start: "00:00", end: "00:00", days: [] }],
    })) };
    const neighbors = parseIpNeighText("192.168.1.50 dev br0 lladdr aa:bb:cc:dd:ee:ff REACHABLE");
    const state = createState();
    await tick(config, state, { ...opts, neighbors });
    await tick(config, state, { ...opts, neighbors });
    assert.deepEqual(urls, ["https://one.example/c/token", "https://two.example/c/token"]);
  });
});

describe("log delivery continuity", () => {
  it("retries a failed log event after the source file rotates and disappears", async () => {
    const path = join(dir, "camera.log");
    await writeFile(path, "old log\n");
    const watcher = { name: "camera-login", path, pattern: "auth success", mantis_url: "https://mantis.example/c/token" };
    const state = createState();
    const lines = [];
    let succeed = false;
    globalThis.fetch = async (_url, init) => {
      lines.push(JSON.parse(init.body).line);
      return new Response(null, { status: succeed ? 204 : 503 });
    };
    await scanLogWatcher(watcher, state, opts);
    await appendFile(path, "auth success: admin\n");
    await scanLogWatcher(watcher, state, opts);
    assert.equal(state.pendingLogs.size, 1);
    assert.equal(state.firedAt.size, 0);
    await rename(path, `${path}.1`);
    await rm(`${path}.1`);
    succeed = true;
    await scanLogWatcher(watcher, state, opts);
    assert.deepEqual(lines, ["auth success: admin", "auth success: admin"]);
    assert.equal(state.pendingLogs.size, 0);
    assert.equal(state.firedAt.size, 1);
  });

  it("gives watchers on the same file separate offsets and cooldowns per destination", async () => {
    const path = join(dir, "shared.log");
    await writeFile(path, "");
    const watchers = ["one", "two"].map((target) => ({ name: "login", path, pattern: "auth success", mantis_url: `https://${target}.example/c/token` }));
    const state = createState();
    const urls = [];
    globalThis.fetch = async (url) => { urls.push(url); return new Response(null, { status: 204 }); };
    for (const watcher of watchers) await scanLogWatcher(watcher, state, opts);
    await appendFile(path, "auth success\n");
    for (const watcher of watchers) await scanLogWatcher(watcher, state, opts);
    assert.deepEqual(urls, ["https://one.example/c/token", "https://two.example/c/token"]);
  });

  it("preserves a log line written across polling ticks", async () => {
    const path = join(dir, "partial.log");
    await writeFile(path, "");
    const watcher = { name: "login", path, pattern: "auth success", mantis_url: "https://mantis.example/c/token" };
    const state = createState();
    const lines = [];
    globalThis.fetch = async (_url, init) => { lines.push(JSON.parse(init.body).line); return new Response(null, { status: 204 }); };
    await scanLogWatcher(watcher, state, opts);
    await appendFile(path, "auth ");
    await scanLogWatcher(watcher, state, opts);
    await appendFile(path, "success\n");
    await scanLogWatcher(watcher, state, opts);
    assert.deepEqual(lines, ["auth success"]);
  });
});

describe("neighbor presence", () => {
  it("rejects FAILED and INCOMPLETE rows in all supported table formats", async () => {
    const device = { ip: "192.168.1.50", mac: "aa:bb:cc:dd:ee:ff" };
    for (const neighbors of [
      parseIpNeighJson(JSON.stringify([{dst: device.ip, lladdr: device.mac, dev: "br0", state: ["FAILED"]}])),
      parseIpNeighText(`${device.ip} dev br0 lladdr ${device.mac} INCOMPLETE`),
      parseArp(`? (${device.ip}) at (incomplete) on en0 ifscope [ethernet]`),
    ]) assert.equal(await isDevicePresent(device, neighbors), false);
  });

  it("respects the configured interface while retaining valid stale neighbors", async () => {
    const neighbors = parseIpNeighJson(JSON.stringify([
      {dst: "192.168.1.50", lladdr: "aa:bb:cc:dd:ee:ff", dev: "br0", state: ["STALE"]},
      {dst: "192.168.1.50", lladdr: "aa:bb:cc:dd:ee:ff", dev: "eth0", state: ["REACHABLE"]},
    ]));
    assert.equal(await isDevicePresent({ ip: "192.168.1.50", interface: "br0" }, neighbors), true);
    assert.equal(await isDevicePresent({ ip: "192.168.1.50", interface: "wlan0" }, neighbors), false);
    const arp = parseArp("? (192.168.1.50) at aa:bb:cc:dd:ee:ff on en0 ifscope [ethernet]");
    assert.equal(await isDevicePresent({ ip: "192.168.1.50", interface: "en1" }, arp), false);
  });
});
