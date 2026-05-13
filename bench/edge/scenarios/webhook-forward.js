/**
 * Webhook forward: does forwarding to a real receiver via `ctx.waitUntil`
 * hurt response latency?
 *
 * Compare:
 *   A) webhook URL pointing at a black hole (127.0.0.1:1) — forward fails fast
 *   B) webhook URL pointing at a local listener that 200s — forward succeeds
 *
 * The worker's response shouldn't change. If p99 diverges, `ctx.waitUntil`
 * is blocking somewhere it shouldn't.
 */
import {
  mintEdgeUrl,
  resolveEdgeKey,
  startWebhookListener,
} from "../setup.js";
import { runAutocannon } from "./_lib.js";

export async function webhookForward({
  workerUrl,
  durationSec,
  connections,
  pipelining,
}) {
  const keyRaw = resolveEdgeKey();

  const blackHoleUrl = await mintEdgeUrl({
    workerUrl,
    webhook: "http://127.0.0.1:1/wh",
    responseKind: "empty",
    keyRaw,
  });

  const listener = await startWebhookListener();
  try {
    const liveUrl = await mintEdgeUrl({
      workerUrl,
      webhook: listener.url,
      responseKind: "empty",
      keyRaw,
    });

    process.stderr.write(`  black-hole webhook …\n`);
    const blackHole = await runAutocannon({
      url: blackHoleUrl,
      durationSec,
      connections,
      pipelining,
    });

    process.stderr.write(`  live webhook (${listener.url}) …\n`);
    const live = await runAutocannon({
      url: liveUrl,
      durationSec,
      connections,
      pipelining,
    });

    const counts = listener.counts();

    return {
      ...live,
      extra: [
        ["black-hole p50/p99/rps", `${blackHole.p50} ms · ${blackHole.p99} ms · ${blackHole.rps} rps`],
        ["live       p50/p99/rps", `${live.p50} ms · ${live.p99} ms · ${live.rps} rps`],
        [
          "Δ p99 (live vs black-hole)",
          Math.round(((live.p99 - blackHole.p99) / Math.max(blackHole.p99, 0.01)) * 100) + " %",
        ],
        ["webhooks received", `${counts.received} (${counts.totalBytes} bytes)`],
        [
          "webhooks lost",
          String(Math.max(0, live.requests - counts.received)),
        ],
      ],
    };
  } finally {
    await listener.close();
  }
}
