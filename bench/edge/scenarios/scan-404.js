/**
 * Scanner load: random invalid blobs at high concurrency.
 *
 * The worker must:
 *   1. Match PATH_RE
 *   2. b64url decode (often will succeed)
 *   3. AES-GCM unseal — will fail (wrong tag) → 404
 *
 * If reject is significantly slower than the happy path that's a finding —
 * attackers can DoS by spamming invalid blobs at the steady-state limit.
 *
 * autocannon doesn't natively rotate URLs per request, so we synthesize a
 * pool of distinct invalid blobs (still matching PATH_RE) and let autocannon
 * cycle via the `requests` array.
 */
import { randomBytes } from "node:crypto";
import autocannon from "autocannon";
import { Buffer } from "node:buffer";

const POOL_SIZE = 64;

export async function scan404({
  workerUrl,
  durationSec,
  connections,
  pipelining,
}) {
  // Build a pool of random base64url blobs — same length as a real sealed
  // envelope so we exercise the full decode path.
  // 1 byte version + 12 nonce + ~64 ct/tag ≈ 77 raw bytes -> ~104 b64url chars
  const blobs = Array.from({ length: POOL_SIZE }, () =>
    Buffer.from(randomBytes(77)).toString("base64url"),
  );
  const requests = blobs.map((b) => ({ path: `/c/${b}`, method: "GET" }));

  const result = await new Promise((resolve, reject) => {
    autocannon(
      {
        url: workerUrl,
        connections,
        duration: durationSec,
        pipelining,
        requests,
      },
      (err, r) => {
        if (err) return reject(err);
        resolve(r);
      },
    );
  });

  const requests_total = result.requests?.total ?? 0;
  const non2xx = result.non2xx ?? 0;
  const p99 = round(result.latency?.p99 ?? 0);
  const p50 = round(result.latency?.p50 ?? 0);
  const rps = round(result.requests?.average ?? 0);
  const errors = result.errors ?? 0;

  return {
    requests: requests_total,
    durationSec: result.duration ?? 0,
    rps,
    p50,
    p95: round(result.latency?.p97_5 ?? result.latency?.p99 ?? 0),
    p99,
    maxLatency: round(result.latency?.max ?? 0),
    errors: errors,
    statusCodes: result.statusCodeStats ?? {},
    extra: [
      ["expected", "all 404"],
      ["non-2xx (good)", String(non2xx)],
      ["socket errors (bad)", String(errors)],
      ["pool size", String(POOL_SIZE)],
    ],
  };
}

function round(n) {
  return Math.round(Number(n) * 100) / 100;
}
