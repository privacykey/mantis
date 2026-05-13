#!/usr/bin/env node
import { readFile, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { spawn } from "node:child_process";
import { platform } from "node:os";

const DEFAULT_INTERVAL_SECONDS = 30;
const DEFAULT_COOLDOWN_SECONDS = 900;

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  printHelp();
  process.exit(0);
}

const configPath = String(args.config ?? process.env.MANTIS_IOT_CONFIG ?? "mantis-iot.json");
const config = await loadConfig(configPath);
const intervalMs = seconds(config.interval_seconds, DEFAULT_INTERVAL_SECONDS) * 1000;
const cooldownMs = seconds(config.cooldown_seconds, DEFAULT_COOLDOWN_SECONDS) * 1000;
const dryRun = Boolean(args["dry-run"] ?? config.dry_run);
const once = Boolean(args.once);

const state = {
  firedAt: new Map(),
  logOffsets: new Map(),
};

console.error(`mantis-iot-helper watching ${config.devices?.length ?? 0} devices, ${config.log_watchers?.length ?? 0} logs`);

do {
  await tick(config, state, { cooldownMs, dryRun });
  if (once) break;
  await sleep(intervalMs);
} while (true);

async function tick(config, state, opts) {
  const neighbors = await getNeighbors();
  const now = new Date();
  for (const device of config.devices ?? []) {
    const present = await isDevicePresent(device, neighbors);
    if (!present) continue;
    if (isAllowedNow(device.allowed, now)) continue;
    await fireWithCooldown({
      key: `device:${device.name}:unexpected-online`,
      state,
      cooldownMs: opts.cooldownMs,
      dryRun: opts.dryRun,
      url: device.mantis_url,
      event: "unexpected-online",
      source: "iot-network",
      device: device.name,
      mac: normalizeMac(device.mac),
      ip: device.ip,
      networkInterface: device.interface ?? config.interface,
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

async function isDevicePresent(device, neighbors) {
  const mac = normalizeMac(device.mac);
  if (mac && neighbors.byMac.has(mac)) return true;
  if (device.ip && neighbors.byIp.has(device.ip)) return true;
  if (device.ping && device.ip) {
    return ping(device.ip);
  }
  return false;
}

function parseIpNeighJson(raw) {
  const byMac = new Map();
  const byIp = new Map();
  try {
    const rows = JSON.parse(raw);
    for (const row of rows) {
      const ip = row.dst;
      const mac = normalizeMac(row.lladdr);
      if (!ip) continue;
      byIp.set(ip, { ip, mac, dev: row.dev, state: row.state });
      if (mac) byMac.set(mac, { ip, mac, dev: row.dev, state: row.state });
    }
  } catch {
    return emptyNeighbors();
  }
  return { byMac, byIp };
}

function parseIpNeighText(raw) {
  const byMac = new Map();
  const byIp = new Map();
  for (const line of raw.split(/\r?\n/)) {
    const ip = line.match(/^(\S+)/)?.[1];
    const dev = line.match(/\bdev\s+(\S+)/)?.[1];
    const mac = normalizeMac(line.match(/\blladdr\s+(\S+)/)?.[1]);
    if (!ip) continue;
    byIp.set(ip, { ip, mac, dev });
    if (mac) byMac.set(mac, { ip, mac, dev });
  }
  return { byMac, byIp };
}

function parseArp(raw) {
  const byMac = new Map();
  const byIp = new Map();
  for (const line of raw.split(/\r?\n/)) {
    const ip = line.match(/\(([^)]+)\)/)?.[1];
    const mac = normalizeMac(line.match(/\bat\s+([0-9a-f:.-]+)/i)?.[1]);
    if (!ip) continue;
    byIp.set(ip, { ip, mac });
    if (mac) byMac.set(mac, { ip, mac });
  }
  return { byMac, byIp };
}

function emptyNeighbors() {
  return { byMac: new Map(), byIp: new Map() };
}

async function ping(ip) {
  const args = platform() === "darwin"
    ? ["-c", "1", "-W", "1000", ip]
    : ["-c", "1", "-W", "1", ip];
  try {
    await run("ping", args, { timeoutMs: 2500 });
    return true;
  } catch {
    return false;
  }
}

async function scanLogWatcher(watcher, state, opts) {
  if (!watcher.path || !watcher.pattern || !watcher.mantis_url) return;
  let info;
  try {
    info = await stat(watcher.path);
  } catch {
    return;
  }

  const previous = state.logOffsets.get(watcher.path) ?? info.size;
  const start = previous > info.size ? 0 : previous;
  state.logOffsets.set(watcher.path, info.size);
  if (start === info.size) return;

  const text = await readRange(watcher.path, start, info.size);
  const re = new RegExp(watcher.pattern, "i");
  for (const line of text.split(/\r?\n/)) {
    if (!re.test(line)) continue;
    await fireWithCooldown({
      key: `log:${watcher.name}`,
      state,
      cooldownMs: opts.cooldownMs,
      dryRun: opts.dryRun,
      url: watcher.mantis_url,
      event: watcher.event ?? "device-log",
      source: "iot-log",
      device: watcher.device ?? watcher.name,
      payload: { watcher: watcher.name, line, at: new Date().toISOString() },
    });
  }
}

async function fireWithCooldown({
  key,
  state,
  cooldownMs,
  dryRun,
  url,
  event,
  source,
  device,
  mac,
  ip,
  networkInterface,
  payload,
}) {
  if (!url) return;
  const now = Date.now();
  const last = state.firedAt.get(key) ?? 0;
  if (now - last < cooldownMs) return;
  state.firedAt.set(key, now);

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
    return;
  }

  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload ?? {}),
    });
    await res.arrayBuffer().catch(() => undefined);
    console.error("fired", event, device ?? "-", res.status);
  } catch (err) {
    console.error("fire failed", event, device ?? "-", err instanceof Error ? err.message : String(err));
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

async function readRange(path, start, end) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const stream = createReadStream(path, {
      start,
      end: Math.max(start, end - 1),
      encoding: "utf8",
    });
    stream.on("data", (chunk) => chunks.push(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(chunks.join("")));
  });
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
