#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

import {
  appendBaseline,
  asNumber,
  assertBudgets,
  parseArgs,
  printSummary,
  summarizeSamples,
} from "../_lib.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASELINE_FILE = resolvePath(__dirname, "baseline.md");
const CLI_BIN_DEFAULT = resolvePath(__dirname, "../../cli/dist/index.js");
const API_KEY = "mantis_live_bench_cli_00000000000000000000000000000000";
const KEY_ID = "11111111-1111-4111-8111-111111111111";

const BUDGETS = {
  version: { p95: 500 },
  help: { p95: 650 },
  "list-json": { p95: 800 },
  "list-table": { p95: 850 },
  "show-json": { p95: 800 },
  "hits-json": { p95: 850 },
  doctor: { p95: 1000 },
};

const SCENARIOS = {
  version: {
    needsServer: false,
    args: () => ["--version"],
  },
  help: {
    needsServer: false,
    args: () => ["--help"],
  },
  "list-json": {
    needsServer: true,
    args: (baseUrl) => authArgs(baseUrl, "--json", "list", "--limit", "50"),
  },
  "list-table": {
    needsServer: true,
    args: (baseUrl) =>
      authArgs(baseUrl, "--no-headers", "list", "--limit", "50"),
  },
  "show-json": {
    needsServer: true,
    args: (baseUrl) => authArgs(baseUrl, "--json", "show", KEY_ID),
  },
  "hits-json": {
    needsServer: true,
    args: (baseUrl) => authArgs(baseUrl, "--json", "hits", KEY_ID),
  },
  doctor: {
    needsServer: true,
    args: (baseUrl) => authArgs(baseUrl, "--json", "doctor", "--public-url", baseUrl),
  },
};

const argv = parseArgs(process.argv.slice(2), {
  iterations: "30",
  warmup: "3",
  "cli-bin": process.env.MANTIS_CLI_BIN ?? CLI_BIN_DEFAULT,
});

if (argv.help) {
  printHelp();
  process.exit(0);
}

const scenarios = argv.scenario
  ? [argv.scenario]
  : argv.all
    ? Object.keys(SCENARIOS)
    : null;

if (!scenarios) {
  printHelp();
  process.exit(1);
}

for (const name of scenarios) {
  if (!SCENARIOS[name]) {
    console.error(`unknown scenario: ${name}`);
    console.error(`available: ${Object.keys(SCENARIOS).join(", ")}`);
    process.exit(2);
  }
}

const cliBin = resolvePath(String(argv["cli-bin"]));
if (!existsSync(cliBin)) {
  console.error(`CLI binary not found at ${cliBin}`);
  console.error("Run `npm --prefix cli run build`, or pass --cli-bin <path>.");
  process.exit(3);
}

const needsServer = scenarios.some((name) => SCENARIOS[name].needsServer);
const server = needsServer ? await startMockApi() : null;
const baseUrl = server?.baseUrl ?? "http://127.0.0.1:0";
const startedAt = new Date().toISOString();
const results = [];

try {
  for (const name of scenarios) {
    const summary = await runScenario({
      name,
      cliBin,
      baseUrl,
      iterations: asNumber(argv.iterations, 30),
      warmup: asNumber(argv.warmup, 3),
    });
    printSummary(name, summary);
    results.push({ scenario: name, summary });
  }
} finally {
  await server?.close();
}

if (argv["write-baseline"]) {
  appendBaseline(BASELINE_FILE, results, startedAt, [
    `cli: \`${cliBin}\``,
    `iterations: \`${argv.iterations}\` · warmup: \`${argv.warmup}\``,
  ]);
  console.error(`\nappended ${results.length} entries to ${BASELINE_FILE}`);
}

if (argv.assert) {
  const failures = assertBudgets(results, BUDGETS);
  if (failures.length > 0) {
    console.error("\nbudget failures:");
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(4);
  }
}

async function runScenario({ name, cliBin, baseUrl, iterations, warmup }) {
  const samples = [];
  const extra = [["iterations", String(iterations)], ["warmup", String(warmup)]];
  const args = SCENARIOS[name].args(baseUrl);

  for (let i = 0; i < warmup; i++) {
    await runCli(cliBin, args);
  }

  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    await runCli(cliBin, args);
    samples.push(performance.now() - t0);
  }

  return summarizeSamples(samples, {
    durationSec: samples.reduce((sum, n) => sum + n, 0) / 1000,
    extra,
  });
}

function runCli(cliBin, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliBin, ...args], {
      env: {
        ...process.env,
        NO_COLOR: "1",
        MANTIS_PROFILE: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`exit ${code}: ${stderr || stdout}`));
    });
  });
}

function authArgs(baseUrl, ...args) {
  return ["--base-url", baseUrl, "--key", API_KEY, ...args];
}

async function startMockApi() {
  const keys = Array.from({ length: 50 }, (_, i) => makeKey(i));
  const hits = Array.from({ length: 50 }, (_, i) => makeHit(i));

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname.startsWith("/api") && req.headers.authorization !== `Bearer ${API_KEY}`) {
      json(res, 401, { error: "unauthorized" });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/health") {
      json(res, 200, {
        status: "ok",
        db: "ok",
        started_at: new Date(0).toISOString(),
        version: "0.1.0",
      });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/keys") {
      json(res, 200, { data: keys, next_cursor: null });
      return;
    }
    if (req.method === "GET" && url.pathname === `/api/keys/${KEY_ID}`) {
      json(res, 200, keys[0]);
      return;
    }
    if (req.method === "GET" && url.pathname === `/api/keys/${KEY_ID}/hits`) {
      json(res, 200, { data: hits, next_cursor: null });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/hits/recent") {
      json(res, 200, {
        data: hits.map((h) => ({
          ...h,
          key: { id: KEY_ID, public_id: "bench-public", memo: "bench key" },
        })),
        next_cursor: null,
      });
      return;
    }
    json(res, 404, { error: "not_found" });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

function json(res, status, body) {
  const raw = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(raw),
  });
  res.end(raw);
}

function makeKey(i) {
  const id = i === 0 ? KEY_ID : `11111111-1111-4111-8111-${String(i).padStart(12, "0")}`;
  return {
    id,
    public_id: `bench-public-${i}`,
    url: `http://127.0.0.1:9/c/bench-public-${i}`,
    kind: "http",
    memo: i === 0 ? "bench key" : `bench key ${i}`,
    response_kind: "empty",
    response_payload: null,
    destinations: [],
    dedupe_window_seconds: 60,
    monitor_mode: "off",
    monitor_window_seconds: 300,
    monitor_reset_at: null,
    monitor_status_url: null,
    created_at: new Date(Date.now() - i * 1000).toISOString(),
    disabled_at: null,
    expires_at: null,
    disabled: false,
  };
}

function makeHit(i) {
  return {
    id: `22222222-2222-4222-8222-${String(i).padStart(12, "0")}`,
    occurred_at: new Date(Date.now() - i * 1000).toISOString(),
    ip: "127.0.0.1",
    user_agent: "mantis-bench/1.0",
    referer: null,
    headers: { host: "bench.local", "user-agent": "mantis-bench/1.0" },
    ua_browser: null,
    ua_browser_version: null,
    ua_os: null,
    ua_device: null,
    bot_label: null,
    is_duplicate: false,
    host_context: null,
    notifications: [],
  };
}

function printHelp() {
  console.error(`mantis CLI bench

Usage:
  node bench/cli/bench.js --scenario=version
  node bench/cli/bench.js --all
  node bench/cli/bench.js --all --assert --write-baseline

Scenarios:
  ${Object.keys(SCENARIOS).join("\n  ")}

Options:
  --cli-bin=<path>       default ${CLI_BIN_DEFAULT}
  --iterations=<n>       default 30
  --warmup=<n>           default 3
  --assert               fail if local budget thresholds are exceeded
  --write-baseline       append results to bench/cli/baseline.md

Notes:
  API-backed scenarios use an in-process mock server so they measure CLI
  startup, argument parsing, rendering, and request overhead without network noise.
`);
}
