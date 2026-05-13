/**
 * Throughput ceiling: ramp connection count and report at each step.
 *
 * Reports a small table — each row is a separate autocannon run. The summary
 * keys (p50/p99/rps) are taken from the highest-concurrency run that didn't
 * blow p99 past `p99CapMs`.
 */
import { mintEdgeUrl, resolveEdgeKey } from "../setup.js";
import { runAutocannon } from "./_lib.js";

const STEPS = [10, 50, 100, 200, 400];
const STEP_DURATION_SEC = 8;
const P99_CAP_MS = 100;

export async function throughputCeiling({ workerUrl }) {
  const keyRaw = resolveEdgeKey();
  const url = await mintEdgeUrl({
    workerUrl,
    webhook: "http://127.0.0.1:1/wh",
    responseKind: "empty",
    keyRaw,
  });

  const runs = [];
  let best = null;

  for (const connections of STEPS) {
    process.stderr.write(
      `  step: ${connections} connections × ${STEP_DURATION_SEC}s …\n`,
    );
    const summary = await runAutocannon({
      url,
      durationSec: STEP_DURATION_SEC,
      connections,
      pipelining: 1,
    });
    runs.push({ connections, summary });
    if (summary.p99 <= P99_CAP_MS) best = { connections, summary };
    // bail early once we double the SLO
    if (summary.p99 > P99_CAP_MS * 2) break;
  }

  const top = best ?? runs[runs.length - 1];
  return {
    ...top.summary,
    extra: [
      ["best concurrency (p99 ≤ " + P99_CAP_MS + "ms)", top.connections],
      ...runs.map(({ connections, summary }) => [
        "  @" + String(connections).padStart(4),
        `${summary.rps} rps · p50 ${summary.p50}ms · p99 ${summary.p99}ms · err ${summary.errors}`,
      ]),
    ],
  };
}
