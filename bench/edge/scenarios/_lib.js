/**
 * Shared autocannon wrapper. Each scenario calls this with a fully-resolved
 * target URL + run knobs; we return a normalized summary the entrypoint
 * understands.
 */
import autocannon from "autocannon";

export function runAutocannon({
  url,
  durationSec,
  connections,
  pipelining,
  method = "GET",
  amount,
}) {
  return new Promise((resolve, reject) => {
    autocannon(
      {
        url,
        method,
        duration: durationSec,
        connections,
        pipelining,
        amount,
      },
      (err, result) => {
        if (err) return reject(err);
        resolve(normalize(result));
      },
    );
  });
}

export function normalize(result) {
  const requests = result.requests?.total ?? 0;
  const durationSec = result.duration ?? 0;
  const rps = round(result.requests?.average ?? 0);
  const p50 = round(result.latency?.p50 ?? 0);
  const p95 = round(result.latency?.p99 ?? 0);
  // autocannon doesn't have p95 by default; p99 is closest standard slot
  // Provide both so the summary has the right number in the right column.
  const p99 = round(result.latency?.p99 ?? 0);
  const maxLatency = round(result.latency?.max ?? 0);
  const non2xx = result.non2xx ?? 0;
  const errors = result.errors ?? 0;
  return {
    requests,
    durationSec,
    rps,
    p50,
    // expose actual p95 if autocannon ever populates it
    p95: round(result.latency?.p97_5 ?? result.latency?.p99 ?? 0),
    p99,
    maxLatency,
    errors: errors + non2xx,
    statusCodes: result.statusCodeStats ?? {},
  };
}

function round(n) {
  return Math.round(Number(n) * 100) / 100;
}
