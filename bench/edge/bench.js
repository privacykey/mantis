/**
 * mantis-edge benchmark entrypoint.
 *
 *   node bench.js --scenario=steady-state
 *   node bench.js --all
 *
 * Options (apply to every scenario unless a scenario overrides):
 *   --worker=<url>           default http://127.0.0.1:8787
 *   --duration=<seconds>     default 30
 *   --connections=<n>        default 10
 *   --pipelining=<n>         default 1
 *   --write-baseline         append summary to baseline.md after each run
 *
 * Pre-req: `npx wrangler dev` running on --worker (default port 8787) with a valid
 * MANTIS_EDGE_KEY in mantis-edge/.dev.vars OR exported in this process.
 */
import minimist from "minimist";
import { appendFileSync } from "node:fs";
import { resolve as resolvePath, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { coldStart } from "./scenarios/cold-start.js";
import { steadyState } from "./scenarios/steady-state.js";
import { throughputCeiling } from "./scenarios/throughput-ceiling.js";
import { blobLength } from "./scenarios/blob-length.js";
import { webhookForward } from "./scenarios/webhook-forward.js";
import { scan404 } from "./scenarios/scan-404.js";

import { probeWorker } from "./setup.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASELINE_FILE = resolvePath(__dirname, "baseline.md");

const SCENARIOS = {
  "cold-start": coldStart,
  "steady-state": steadyState,
  "throughput-ceiling": throughputCeiling,
  "blob-length": blobLength,
  "webhook-forward": webhookForward,
  "scan-404": scan404,
};

const argv = minimist(process.argv.slice(2), {
  string: ["scenario", "worker", "duration", "connections", "pipelining"],
  boolean: ["all", "write-baseline", "help"],
  default: {
    worker: process.env.MANTIS_EDGE_BENCH_WORKER ?? "http://127.0.0.1:8787",
    duration: "30",
    connections: "10",
    pipelining: "1",
  },
  alias: { h: "help" },
});

if (argv.help) {
  printHelp();
  process.exit(0);
}

const scenariosToRun = argv.all
  ? Object.keys(SCENARIOS)
  : argv.scenario
    ? [argv.scenario]
    : null;

if (!scenariosToRun) {
  printHelp();
  process.exit(1);
}

for (const name of scenariosToRun) {
  if (!SCENARIOS[name]) {
    console.error(`unknown scenario: ${name}`);
    console.error(`available: ${Object.keys(SCENARIOS).join(", ")}`);
    process.exit(2);
  }
}

const baseOpts = {
  workerUrl: argv.worker.replace(/\/$/, ""),
  durationSec: Number(argv.duration),
  connections: Number(argv.connections),
  pipelining: Number(argv.pipelining),
};

console.error(`probing ${baseOpts.workerUrl} …`);
const reachable = await probeWorker(baseOpts.workerUrl);
if (!reachable) {
  console.error(
    `worker at ${baseOpts.workerUrl} did not return 404 for an invalid blob.`,
  );
  console.error(`is \`npx wrangler dev\` running? (cd mantis-edge && npx wrangler dev)`);
  process.exit(3);
}
console.error("worker reachable.\n");

const runStartedAt = new Date().toISOString();
const results = [];

for (const name of scenariosToRun) {
  console.error(`\n=== ${name} ===`);
  const fn = SCENARIOS[name];
  try {
    const summary = await fn(baseOpts);
    printSummary(name, summary);
    results.push({ scenario: name, summary });
  } catch (err) {
    console.error(
      `scenario ${name} failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    if (err instanceof Error && err.stack) console.error(err.stack);
    results.push({
      scenario: name,
      summary: {
        error: err instanceof Error ? err.message : String(err),
      },
    });
  }
}

if (argv["write-baseline"]) {
  writeBaseline(results, runStartedAt);
  console.error(`\nappended ${results.length} entries to ${BASELINE_FILE}`);
}

function printSummary(name, summary) {
  if (summary.error) {
    console.error(`  ERROR: ${summary.error}`);
    return;
  }
  const rows = [
    ["requests", summary.requests],
    ["duration", summary.durationSec + "s"],
    ["throughput", summary.rps + " req/s"],
    ["p50 latency", summary.p50 + " ms"],
    ["p95 latency", summary.p95 + " ms"],
    ["p99 latency", summary.p99 + " ms"],
    ["max latency", summary.maxLatency + " ms"],
    ["non-2xx/3xx", summary.errors],
  ];
  for (const extra of summary.extra ?? []) rows.push(extra);
  for (const [k, v] of rows) {
    console.error(`  ${k.padEnd(14)} ${v}`);
  }
}

function writeBaseline(entries, startedAt) {
  const lines = [];
  lines.push(`\n## ${startedAt}`);
  lines.push("");
  lines.push(`host: \`${process.platform}-${process.arch}\` · node \`${process.version}\``);
  lines.push("");
  for (const { scenario, summary } of entries) {
    lines.push(`### ${scenario}`);
    if (summary.error) {
      lines.push(`\n_error: ${summary.error}_`);
      continue;
    }
    lines.push("");
    lines.push("| metric | value |");
    lines.push("|---|---|");
    lines.push(`| requests | ${summary.requests} |`);
    lines.push(`| duration | ${summary.durationSec} s |`);
    lines.push(`| throughput | ${summary.rps} req/s |`);
    lines.push(`| p50 | ${summary.p50} ms |`);
    lines.push(`| p95 | ${summary.p95} ms |`);
    lines.push(`| p99 | ${summary.p99} ms |`);
    lines.push(`| max | ${summary.maxLatency} ms |`);
    lines.push(`| non-2xx | ${summary.errors} |`);
    for (const [k, v] of summary.extra ?? []) {
      lines.push(`| ${k} | ${v} |`);
    }
    lines.push("");
  }
  appendFileSync(BASELINE_FILE, lines.join("\n"));
}

function printHelp() {
  console.error(`mantis-edge bench

Usage:
  node bench.js --scenario=<name>          run one
  node bench.js --all                      run all
  node bench.js --all --write-baseline     run all + commit numbers to baseline.md

Scenarios:
  ${Object.keys(SCENARIOS).join("\n  ")}

Options:
  --worker=<url>           default http://127.0.0.1:8787 (env: MANTIS_EDGE_BENCH_WORKER)
  --duration=<seconds>     default 30
  --connections=<n>        default 10
  --pipelining=<n>         default 1

Prerequisites:
  cd mantis-edge && npx wrangler dev      (worker on 8787)
  MANTIS_EDGE_KEY=...                     OR mantis-edge/.dev.vars MANTIS_EDGE_KEY=…
`);
}
