import { appendFileSync } from "node:fs";
import { performance } from "node:perf_hooks";

export function parseArgs(argv, defaults = {}) {
  const out = { ...defaults };
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i];
    if (!raw.startsWith("--")) continue;
    const eq = raw.indexOf("=");
    const key = raw.slice(2, eq === -1 ? undefined : eq);
    if (eq !== -1) {
      out[key] = raw.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      out[key] = next;
      i++;
    } else {
      out[key] = true;
    }
  }
  return out;
}

export function asNumber(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function round(n) {
  return Math.round(Number(n) * 100) / 100;
}

export function summarizeSamples(samples, {
  durationSec,
  errors = 0,
  statusCounts = {},
  extra = [],
} = {}) {
  const sorted = [...samples].sort((a, b) => a - b);
  const requests = sorted.length;
  return {
    requests,
    durationSec: round(durationSec ?? 0),
    rps: round(durationSec ? requests / durationSec : 0),
    p50: round(percentile(sorted, 0.5)),
    p95: round(percentile(sorted, 0.95)),
    p99: round(percentile(sorted, 0.99)),
    maxLatency: round(sorted[sorted.length - 1] ?? 0),
    errors,
    statusCounts,
    extra,
  };
}

export async function runTimedLoad({
  durationSec,
  concurrency,
  request,
  okStatus = (status) => status >= 200 && status < 400,
}) {
  const samples = [];
  const statusCounts = {};
  let errors = 0;
  let seq = 0;
  const started = performance.now();
  const deadline = started + durationSec * 1000;

  async function worker() {
    while (performance.now() < deadline) {
      const n = seq++;
      const t0 = performance.now();
      try {
        const result = await request(n);
        const elapsed = performance.now() - t0;
        const status = typeof result === "number" ? result : result?.status;
        if (typeof status === "number") {
          statusCounts[status] = (statusCounts[status] ?? 0) + 1;
          if (!okStatus(status)) errors++;
        }
        samples.push(elapsed);
      } catch {
        errors++;
        samples.push(performance.now() - t0);
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.max(1, concurrency) }, () => worker()),
  );

  return summarizeSamples(samples, {
    durationSec: (performance.now() - started) / 1000,
    errors,
    statusCounts,
  });
}

export function printSummary(name, summary) {
  if (summary.error) {
    console.error(`  ERROR: ${summary.error}`);
    return;
  }
  const rows = [
    ["requests", summary.requests],
    ["duration", `${summary.durationSec}s`],
    ["throughput", `${summary.rps} req/s`],
    ["p50 latency", `${summary.p50} ms`],
    ["p95 latency", `${summary.p95} ms`],
    ["p99 latency", `${summary.p99} ms`],
    ["max latency", `${summary.maxLatency} ms`],
    ["errors", summary.errors],
  ];
  for (const extra of summary.extra ?? []) rows.push(extra);
  console.error(`\n=== ${name} ===`);
  for (const [k, v] of rows) console.error(`  ${k.padEnd(14)} ${v}`);
}

export function appendBaseline(file, entries, startedAt, headingExtra = []) {
  const lines = [];
  lines.push(`\n## ${startedAt}`);
  lines.push("");
  lines.push(`host: \`${process.platform}-${process.arch}\` · node \`${process.version}\``);
  for (const line of headingExtra) lines.push(line);
  lines.push("");
  for (const { scenario, summary } of entries) {
    lines.push(`### ${scenario}`);
    if (summary.error) {
      lines.push("");
      lines.push(`_error: ${summary.error}_`);
      lines.push("");
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
    lines.push(`| errors | ${summary.errors} |`);
    for (const [k, v] of summary.extra ?? []) lines.push(`| ${k} | ${v} |`);
    lines.push("");
  }
  appendFileSync(file, lines.join("\n"));
}

export function assertBudgets(entries, budgets) {
  const failures = [];
  for (const { scenario, summary } of entries) {
    const budget = budgets[scenario];
    if (!budget || summary.error) continue;
    for (const [metric, limit] of Object.entries(budget)) {
      if ((summary[metric] ?? 0) > limit) {
        failures.push(
          `${scenario} ${metric} ${summary[metric]} exceeded ${limit}`,
        );
      }
    }
  }
  return failures;
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * p) - 1),
  );
  return sorted[idx] ?? 0;
}
