#!/usr/bin/env node
import { open, readFile, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { platform } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_INTERVAL_SECONDS = 30;
const DEFAULT_COOLDOWN_SECONDS = 900;
const DEFAULT_DELIVERY_TIMEOUT_SECONDS = 10;

// Bounds for one log watcher in one poll. A watched log is filled by whatever
// the host's syslog receiver accepts from the LAN, so how much it grows
// between polls is not under the operator's control. Nothing the watcher
// holds in memory may scale with that growth, or a burst could exhaust the
// heap and abort the process before the matching line is alerted.
//   - the log is read in fixed-size chunks (the only log data in memory);
//   - only the first LOG_MAX_LINE_BYTES of a line are matched and reported;
//   - at most LOG_MAX_EVENTS_PER_POLL matches are turned into events, and at
//     most about LOG_MAX_BYTES_PER_POLL are read, per watcher per poll.
// Whatever is left stays in the file and is read on the following polls, from
// exactly where this one stopped — nothing is skipped.
const LOG_CHUNK_BYTES = 256 * 1024;
const LOG_MAX_LINE_BYTES = 16 * 1024;
const LOG_MAX_BYTES_PER_POLL = 32 * 1024 * 1024;
const LOG_MAX_EVENTS_PER_POLL = 64;

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    printHelp();
    return;
  }

  const configPath = String(args.config ?? process.env.MANTIS_IOT_CONFIG ?? "mantis-iot.json");
  const config = await loadConfig(configPath);
  const intervalMs = seconds(config.interval_seconds, DEFAULT_INTERVAL_SECONDS) * 1000;
  const cooldownMs = seconds(config.cooldown_seconds, DEFAULT_COOLDOWN_SECONDS) * 1000;
  const deliveryTimeoutMs = seconds(config.delivery_timeout_seconds, DEFAULT_DELIVERY_TIMEOUT_SECONDS) * 1000;
  const dryRun = Boolean(args["dry-run"] ?? config.dry_run);
  const once = Boolean(args.once);

  const state = createState();

  console.error(`mantis-iot-helper watching ${config.devices?.length ?? 0} devices, ${config.log_watchers?.length ?? 0} logs`);

  do {
    await tick(config, state, { cooldownMs, dryRun, deliveryTimeoutMs });
    if (once) break;
    await sleep(intervalMs);
  } while (true);
}

export function createState() {
  return { firedAt: new Map(), logOffsets: new Map(), pendingLogs: new Map() };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}

export async function tick(config, state, opts) {
  const neighbors = opts.neighbors ?? await getNeighbors();
  const now = new Date();
  for (const device of config.devices ?? []) {
    const networkInterface = device.interface ?? config.interface;
    const present = await isDevicePresent({ ...device, interface: networkInterface }, neighbors);
    if (!present) continue;
    if (isAllowedNow(device.allowed, now)) continue;
    await fireWithCooldown({
      key: `device:${device.name}:unexpected-online`,
      state,
      cooldownMs: opts.cooldownMs,
      dryRun: opts.dryRun,
      deliveryTimeoutMs: opts.deliveryTimeoutMs,
      url: device.mantis_url,
      event: "unexpected-online",
      source: "iot-network",
      device: device.name,
      mac: normalizeMac(device.mac),
      ip: device.ip,
      networkInterface,
      payload: { device, present, at: now.toISOString() },
    });
  }

  for (const watcher of config.log_watchers ?? []) {
    await scanLogWatcher(watcher, state, opts);
  }
}

async function getNeighbors() {
  if (platform() === "linux") {
    const json = await run("ip", ["-j", "neigh"]).catch(() => null);
    if (json) return parseIpNeighJson(json);
    const text = await run("ip", ["neigh"]).catch(() => "");
    return parseIpNeighText(text);
  }
  const arp = await run("arp", ["-an"]).catch(() => "");
  return parseArp(arp);
}

export async function isDevicePresent(device, neighbors) {
  const mac = normalizeMac(device.mac);
  const entries = neighbors.entries ?? [...neighbors.byMac.values(), ...neighbors.byIp.values()];
  if (entries.some((entry) =>
    (!device.interface || entry.dev === device.interface) &&
    ((mac && entry.mac === mac) || (device.ip && entry.ip === device.ip))
  )) return true;
  if (device.ping && device.ip) {
    return ping(device.ip, device.interface);
  }
  return false;
}

export function parseIpNeighJson(raw) {
  const neighbors = emptyNeighbors();
  try {
    const rows = JSON.parse(raw);
    for (const row of rows) {
      const ip = row.dst;
      const mac = normalizeMac(row.lladdr);
      if (!ip || invalidNeighborState(row.state)) continue;
      addNeighbor(neighbors, { ip, mac, dev: row.dev, state: row.state });
    }
  } catch {
    return emptyNeighbors();
  }
  return neighbors;
}

export function parseIpNeighText(raw) {
  const neighbors = emptyNeighbors();
  for (const line of raw.split(/\r?\n/)) {
    const ip = line.match(/^(\S+)/)?.[1];
    const dev = line.match(/\bdev\s+(\S+)/)?.[1];
    const mac = normalizeMac(line.match(/\blladdr\s+(\S+)/)?.[1]);
    if (!ip || invalidNeighborState(line)) continue;
    addNeighbor(neighbors, { ip, mac, dev });
  }
  return neighbors;
}

export function parseArp(raw) {
  const neighbors = emptyNeighbors();
  for (const line of raw.split(/\r?\n/)) {
    const ip = line.match(/\(([^)]+)\)/)?.[1];
    const mac = normalizeMac(line.match(/\bat\s+([0-9a-f:.-]+)/i)?.[1]);
    const dev = line.match(/\bon\s+(\S+)/)?.[1];
    if (!ip || invalidNeighborState(line)) continue;
    addNeighbor(neighbors, { ip, mac, dev });
  }
  return neighbors;
}

function emptyNeighbors() {
  return { byMac: new Map(), byIp: new Map(), entries: [] };
}

function invalidNeighborState(value) {
  return /\b(FAILED|INCOMPLETE)\b/i.test(Array.isArray(value) ? value.join(" ") : String(value ?? ""));
}

function addNeighbor(neighbors, entry) {
  neighbors.entries.push(entry);
  neighbors.byIp.set(entry.ip, entry);
  if (entry.mac) neighbors.byMac.set(entry.mac, entry);
}

async function ping(ip, networkInterface) {
  const args = platform() === "darwin"
    ? ["-c", "1", "-W", "1000", ip]
    : ["-c", "1", "-W", "1", ip];
  if (networkInterface) args.unshift(platform() === "darwin" ? "-b" : "-I", networkInterface);
  try {
    await run("ping", args, { timeoutMs: 2500 });
    return true;
  } catch {
    return false;
  }
}

export async function scanLogWatcher(watcher, state, opts) {
  if (!watcher.path || !watcher.pattern || !watcher.mantis_url) return;
  // Each destination consumes its own stream, even when it watches the same
  // file/name. Keep failed events outside the file so rotation cannot lose them.
  const key = JSON.stringify([watcher.name, watcher.path, watcher.pattern, watcher.event, watcher.mantis_url]);
  if (!await flushPendingLogs(key, state)) return;
  let info;
  try {
    info = await stat(watcher.path);
  } catch {
    return;
  }

  const previous = state.logOffsets.get(key);
  const fileId = `${info.dev}:${info.ino}`;
  const continuing = previous && previous.fileId === fileId && previous.offset <= info.size;
  // `offset` is the first byte not yet consumed: always the start of a line,
  // or — while `skipping` — somewhere inside an over-long line whose head has
  // already been scanned. A new file starts at its end, the same file carries
  // on, and a rotated or truncated file starts over.
  const position = {
    offset: !previous ? info.size : continuing ? previous.offset : 0,
    fileId,
    skipping: continuing ? Boolean(previous.skipping) : false,
  };
  state.logOffsets.set(key, position);
  if (position.offset >= info.size) return;

  const limits = logLimits(opts);
  const re = new RegExp(watcher.pattern, "i");
  // While this watcher is in its cooldown a match cannot alert (delivery
  // would discard it), so it is not worth an event — and must not use up the
  // per-poll event budget, or a run of matching lines would hold back the
  // rest of the log for no alert at all.
  const eventKey = `log:${key}`;
  const cooldownKey = JSON.stringify([eventKey, watcher.mantis_url]);
  const coolingDown = () => {
    const last = state.firedAt.get(cooldownKey);
    return last !== undefined && Date.now() - last < opts.cooldownMs;
  };
  let handle;
  try {
    handle = await open(watcher.path, "r");
    const buffer = Buffer.allocUnsafe(limits.chunkBytes);
    let bytesRead = 0;
    let built = 0;
    while (
      position.offset < info.size &&
      bytesRead < limits.maxBytesPerPoll &&
      built < limits.maxEventsPerPoll
    ) {
      const want = Math.min(buffer.length, info.size - position.offset);
      const { bytesRead: n } = await handle.read(buffer, 0, want, position.offset);
      if (n === 0) break;
      bytesRead += n;

      const events = [];
      let pos = 0;
      while (pos < n && built + events.length < limits.maxEventsPerPoll) {
        const newline = buffer.indexOf(0x0a, pos);
        const lineBreak = newline === -1 || newline >= n ? -1 : newline;
        if (position.skipping) {
          // The rest of an over-long line: discard up to its line break.
          if (lineBreak === -1) {
            pos = n;
            break;
          }
          pos = lineBreak + 1;
          position.skipping = false;
          continue;
        }
        // No line break yet and still within the line cap: leave the partial
        // line in the file; it is read again once the rest has been written.
        if (lineBreak === -1 && n - pos <= limits.maxLineBytes) break;

        const end = lineBreak === -1 ? n : lineBreak;
        let line = buffer.toString("utf8", pos, Math.min(end, pos + limits.maxLineBytes));
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (re.test(line) && !coolingDown()) {
          events.push({
            key: eventKey,
            state,
            cooldownMs: opts.cooldownMs,
            dryRun: opts.dryRun,
            deliveryTimeoutMs: opts.deliveryTimeoutMs,
            url: watcher.mantis_url,
            event: watcher.event ?? "device-log",
            source: "iot-log",
            device: watcher.device ?? watcher.name,
            payload: { watcher: watcher.name, line, at: new Date().toISOString() },
          });
        }
        if (lineBreak === -1) {
          // Over the line cap with no line break in sight: the head has been
          // scanned, so drop the remainder as it arrives.
          position.skipping = true;
          pos = n;
        } else {
          pos = lineBreak + 1;
        }
      }
      if (pos === 0) break; // only an unfinished line is left
      position.offset += pos;

      // Deliver before reading on, so an alert never waits for the backlog.
      // A failed delivery keeps its events (retried next poll) and stops the
      // scan; the unread part of the file is picked up after they are sent.
      if (events.length) {
        built += events.length;
        state.pendingLogs.set(key, events);
        if (!await flushPendingLogs(key, state)) break;
      }
    }
  } catch (err) {
    console.error("log read failed", watcher.name, err instanceof Error ? err.message : String(err));
  } finally {
    await handle?.close().catch(() => {});
  }
}

function logLimits(opts) {
  const custom = opts?.logLimits ?? {};
  const pick = (value, fallback) => (Number.isInteger(value) && value > 0 ? value : fallback);
  const maxLineBytes = pick(custom.maxLineBytes, LOG_MAX_LINE_BYTES);
  return {
    maxLineBytes,
    // A chunk must be able to hold one capped line plus its line break, or a
    // read that starts at a line could make no progress.
    chunkBytes: Math.max(pick(custom.chunkBytes, LOG_CHUNK_BYTES), maxLineBytes + 2),
    maxBytesPerPoll: pick(custom.maxBytesPerPoll, LOG_MAX_BYTES_PER_POLL),
    maxEventsPerPoll: pick(custom.maxEventsPerPoll, LOG_MAX_EVENTS_PER_POLL),
  };
}

async function flushPendingLogs(key, state) {
  const events = state.pendingLogs.get(key) ?? [];
  while (events.length) {
    if (!await fireWithCooldown(events[0])) return false;
    events.shift();
  }
  state.pendingLogs.delete(key);
  return true;
}

export async function fireWithCooldown({
  key,
  state,
  cooldownMs,
  dryRun,
  deliveryTimeoutMs = DEFAULT_DELIVERY_TIMEOUT_SECONDS * 1000,
  url,
  event,
  source,
  device,
  mac,
  ip,
  networkInterface,
  payload,
}) {
  if (!url) return false;
  const targetKey = JSON.stringify([key, url]);
  const now = Date.now();
  const last = state.firedAt.get(targetKey);
  if (last !== undefined && now - last < cooldownMs) return true;

  const headers = {
    "Content-Type": "application/json",
    "X-Mantis-Source": source,
    "X-Mantis-Event": event,
    "X-Mantis-Device": device ?? "",
    "X-Mantis-Iot-Mac": mac ?? "",
    "X-Mantis-Iot-Ip": ip ?? "",
    "X-Mantis-Network-Interface": networkInterface ?? "",
  };

  if (dryRun) {
    console.error("dry-run fire", event, device, url);
    state.firedAt.set(targetKey, now);
    return true;
  }

  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload ?? {}),
      redirect: "manual",
      signal: AbortSignal.timeout(Math.max(1, Math.floor(deliveryTimeoutMs))),
    });
    // The trigger has accepted the event once its response headers arrive.
    // Don't wait for an arbitrary response body or follow redirect targets.
    void res.body?.cancel().catch(() => {});
    if (res.status < 200 || res.status >= 400) throw new Error(`HTTP ${res.status}`);
    state.firedAt.set(targetKey, Date.now());
    console.error("fired", event, device ?? "-", res.status);
    return true;
  } catch (err) {
    console.error("fire failed", event, device ?? "-", err instanceof Error ? err.message : String(err));
    return false;
  }
}

function isAllowedNow(windows, now) {
  if (!Array.isArray(windows) || windows.length === 0) return true;
  const day = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"][now.getDay()];
  const minute = now.getHours() * 60 + now.getMinutes();
  return windows.some((window) => {
    if (Array.isArray(window.days) && !window.days.map(String).map((d) => d.toLowerCase()).includes(day)) {
      return false;
    }
    const start = parseHm(window.start ?? "00:00");
    const end = parseHm(window.end ?? "23:59");
    if (start <= end) return minute >= start && minute <= end;
    return minute >= start || minute <= end;
  });
}

function parseHm(raw) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(raw));
  if (!match) return 0;
  return Math.min(1439, Math.max(0, Number(match[1]) * 60 + Number(match[2])));
}

function run(cmd, args, { timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${cmd} timed out`));
    }, timeoutMs);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr || `${cmd} exited ${code}`));
    });
  });
}

async function loadConfig(path) {
  const raw = await readFile(path, "utf8");
  return JSON.parse(raw);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i];
    if (!raw.startsWith("--")) continue;
    const eq = raw.indexOf("=");
    const key = raw.slice(2, eq === -1 ? undefined : eq);
    if (eq !== -1) out[key] = raw.slice(eq + 1);
    else if (argv[i + 1] && !argv[i + 1].startsWith("--")) out[key] = argv[++i];
    else out[key] = true;
  }
  return out;
}

function seconds(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function normalizeMac(raw) {
  if (!raw) return null;
  const compact = String(raw).toLowerCase().replace(/[^0-9a-f]/g, "");
  if (compact.length !== 12) return null;
  return compact.match(/../g).join(":");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function printHelp() {
  console.error(`mantis-iot-helper

Usage:
  mantis-iot-helper --config mantis-iot.json
  mantis-iot-helper --config mantis-iot.json --once --dry-run

What it watches:
  - ARP/neighbor table entries for configured MAC/IP devices
  - optional ping probes for configured IPs
  - optional log files for login/auth patterns

Config:
  See iot-helper/config.example.json.
`);
}
