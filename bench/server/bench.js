#!/usr/bin/env node
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

import {
  appendBaseline,
  asNumber,
  assertBudgets,
  parseArgs,
  printSummary,
  runTimedLoad,
} from "../_lib.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASELINE_FILE = resolvePath(__dirname, "baseline.md");

const BUDGETS = {
  health: { p99: 150 },
  "api-list": { p99: 250 },
  "trigger-hit": { p99: 350 },
  "recent-hits": { p99: 300 },
  "key-hits": { p99: 300 },
};

const SCENARIOS = {
  health: {
    needsAuth: false,
    needsKey: false,
    request: (ctx) => drain(fetch(urlJoin(ctx.baseUrl, "/api/health"))),
  },
  "api-list": {
    needsAuth: true,
    needsKey: false,
    request: (ctx) =>
      drain(fetch(urlJoin(ctx.baseUrl, "/api/keys?limit=50"), authInit(ctx))),
  },
  "trigger-hit": {
    needsAuth: true,
    needsKey: true,
    request: (ctx, n) => drain(fetch(withBenchQuery(ctx.key.url, n))),
  },
  "recent-hits": {
    needsAuth: true,
    needsKey: true,
    request: (ctx) =>
      drain(
        fetch(
          urlJoin(
            ctx.baseUrl,
            `/api/hits/recent?limit=50&key_id=${encodeURIComponent(ctx.key.id)}`,
          ),
          authInit(ctx),
        ),
      ),
  },
  "key-hits": {
    needsAuth: true,
    needsKey: true,
    request: (ctx) =>
      drain(
        fetch(
          urlJoin(
            ctx.baseUrl,
            `/api/keys/${encodeURIComponent(ctx.key.id)}/hits?limit=50`,
          ),
          authInit(ctx),
        ),
      ),
  },
};

const argv = parseArgs(process.argv.slice(2), {
  url: process.env.MANTIS_BENCH_URL ?? "http://127.0.0.1:3000",
  key: process.env.MANTIS_BENCH_KEY,
  duration: "15",
  concurrency: "10",
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

const needsAuth = scenarios.some((name) => SCENARIOS[name].needsAuth);
const needsKey = scenarios.some((name) => SCENARIOS[name].needsKey);
if (needsAuth && !argv.key) {
  console.error("Mantis API key required. Pass --key or set MANTIS_BENCH_KEY.");
  process.exit(3);
}

const ctx = {
  baseUrl: String(argv.url).replace(/\/$/, ""),
  apiKey: argv.key ? String(argv.key) : "",
  key: null,
};

console.error(`probing ${ctx.baseUrl} ...`);
await assertReachable(ctx.baseUrl);
console.error("server reachable.\n");

if (needsKey) {
  ctx.key = argv["key-id"]
    ? await loadKey(ctx, String(argv["key-id"]))
    : await createBenchKey(ctx);
  if (argv["trigger-base-url"]) {
    ctx.key = {
      ...ctx.key,
      url: rewriteOrigin(ctx.key.url, String(argv["trigger-base-url"])),
    };
  }
  await seedHits(ctx, 5);
}

const startedAt = new Date().toISOString();
const results = [];

try {
  for (const name of scenarios) {
    const summary = await runTimedLoad({
      durationSec: asNumber(argv.duration, 15),
      concurrency: asNumber(argv.concurrency, 10),
      request: (n) => SCENARIOS[name].request(ctx, n),
    });
    summary.extra = [
      ["target", ctx.baseUrl],
      ["concurrency", String(argv.concurrency)],
    ];
    printSummary(name, summary);
    results.push({ scenario: name, summary });
  }
} finally {
  if (ctx.key && !argv["key-id"] && !argv["keep-key"]) {
    await deleteKey(ctx, ctx.key.id).catch(() => undefined);
  }
}

if (argv["write-baseline"]) {
  appendBaseline(BASELINE_FILE, results, startedAt, [
    `target: \`${ctx.baseUrl}\``,
    `duration: \`${argv.duration}s\` · concurrency: \`${argv.concurrency}\``,
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

async function assertReachable(baseUrl) {
  const status = await drain(fetch(urlJoin(baseUrl, "/api/health")));
  if (status < 200 || status >= 500) {
    throw new Error(`/api/health returned HTTP ${status}`);
  }
}

async function createBenchKey(ctx) {
  const res = await fetch(urlJoin(ctx.baseUrl, "/api/keys"), {
    ...authInit(ctx),
    method: "POST",
    headers: {
      ...authInit(ctx).headers,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      memo: `bench ${new Date().toISOString()}`,
      response_kind: "empty",
      dedupe_window_seconds: 0,
    }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(`failed to create bench key: HTTP ${res.status}`);
  }
  return body;
}

async function loadKey(ctx, id) {
  const res = await fetch(
    urlJoin(ctx.baseUrl, `/api/keys/${encodeURIComponent(id)}`),
    authInit(ctx),
  );
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`failed to load key ${id}: HTTP ${res.status}`);
  return body;
}

async function deleteKey(ctx, id) {
  await drain(
    fetch(urlJoin(ctx.baseUrl, `/api/keys/${encodeURIComponent(id)}`), {
      ...authInit(ctx),
      method: "DELETE",
    }),
  );
}

async function seedHits(ctx, count) {
  for (let i = 0; i < count; i++) {
    await drain(fetch(withBenchQuery(ctx.key.url, `seed-${i}`))).catch(
      () => undefined,
    );
  }
}

async function drain(promise) {
  const res = await promise;
  await res.arrayBuffer().catch(() => undefined);
  return res.status;
}

function authInit(ctx) {
  return { headers: { authorization: `Bearer ${ctx.apiKey}` } };
}

function urlJoin(baseUrl, path) {
  return new URL(path, baseUrl).toString();
}

function withBenchQuery(raw, value) {
  const url = new URL(raw);
  url.searchParams.set("bench", String(value));
  return url.toString();
}

function rewriteOrigin(raw, baseUrl) {
  const original = new URL(raw);
  const base = new URL(baseUrl);
  original.protocol = base.protocol;
  original.host = base.host;
  return original.toString();
}

function printHelp() {
  console.error(`mantis server/container bench

Usage:
  node bench/server/bench.js --scenario=health
  MANTIS_BENCH_KEY=mantis_live_... node bench/server/bench.js --all
  node bench/server/bench.js --all --assert --write-baseline

Scenarios:
  ${Object.keys(SCENARIOS).join("\n  ")}

Options:
  --url=<url>           default http://127.0.0.1:3000 (env: MANTIS_BENCH_URL)
  --key=<api-key>       env: MANTIS_BENCH_KEY
  --key-id=<uuid>       use an existing key instead of creating a temporary one
  --trigger-base-url=<url>
                        rewrite generated trigger URLs to this origin
  --duration=<seconds>  default 15
  --concurrency=<n>     default 10
  --keep-key            do not delete the temporary bench key
  --assert              fail if local budget thresholds are exceeded
  --write-baseline      append results to bench/server/baseline.md

Notes:
  This targets a running main Mantis server/container. Start Docker first, then
  pass the bootstrap/API key as MANTIS_BENCH_KEY.
`);
}
