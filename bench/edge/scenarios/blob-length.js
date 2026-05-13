/**
 * Blob length impact: run steady-state twice, once with a minimal payload
 * (~120 chars total URL) and once with a loaded one (~400 chars).
 *
 * Validates the docs claim that edge URL length doesn't materially affect
 * latency. If p99 differs by more than 25%, that's a real finding.
 */
import { mintEdgeUrl, resolveEdgeKey } from "../setup.js";
import { runAutocannon } from "./_lib.js";

export async function blobLength({
  workerUrl,
  durationSec,
  connections,
  pipelining,
}) {
  const keyRaw = resolveEdgeKey();

  const minimalUrl = await mintEdgeUrl({
    workerUrl,
    webhook: "http://127.0.0.1:1/x",
    responseKind: "empty",
    keyRaw,
  });

  const heavyUrl = await mintEdgeUrl({
    workerUrl,
    webhook:
      "http://127.0.0.1:1/discord/api/webhooks/" +
      "1234567890123456789/aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789-aBcDeFgHiJkLmNoPqRsTuVwXyZ_01234567890",
    memo: "blob-length stress: a fairly long memo emulating real usage",
    responseKind: "json",
    responsePayload: { status: "ok", reason: "synthetic test response" },
    keyRaw,
  });

  process.stderr.write(`  minimal URL (${minimalUrl.length} chars) …\n`);
  const minimal = await runAutocannon({
    url: minimalUrl,
    durationSec,
    connections,
    pipelining,
  });

  process.stderr.write(`  heavy URL  (${heavyUrl.length} chars) …\n`);
  const heavy = await runAutocannon({
    url: heavyUrl,
    durationSec,
    connections,
    pipelining,
  });

  // Report headline as the heavy run; extra rows show the comparison.
  return {
    ...heavy,
    extra: [
      ["minimal URL chars", String(minimalUrl.length)],
      ["minimal p50/p99/rps", `${minimal.p50} ms · ${minimal.p99} ms · ${minimal.rps} rps`],
      ["heavy URL chars  ", String(heavyUrl.length)],
      ["heavy p50/p99/rps  ", `${heavy.p50} ms · ${heavy.p99} ms · ${heavy.rps} rps`],
      [
        "Δ p99",
        Math.round(((heavy.p99 - minimal.p99) / Math.max(minimal.p99, 0.01)) * 100) + " %",
      ],
    ],
  };
}
