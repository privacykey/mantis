/**
 * Cold-start: single connection, single request, measured one-shot. Run
 * multiple times if you want a distribution; we report this one as a sample.
 *
 * Wrangler dev keeps the isolate warm during the run, so this approximates
 * "first request after script-eval" rather than a true CF colocation cold
 * start. Useful as a relative-cost baseline; for deployed numbers a manual
 * `npx wrangler tail` after extended idle is the reference.
 */
import { mintEdgeUrl, resolveEdgeKey } from "../setup.js";
import { runAutocannon } from "./_lib.js";

export async function coldStart({ workerUrl }) {
  const keyRaw = resolveEdgeKey();
  const url = await mintEdgeUrl({
    workerUrl,
    webhook: "http://127.0.0.1:1/wh",
    responseKind: "empty",
    keyRaw,
  });

  const summary = await runAutocannon({
    url,
    durationSec: 1,
    connections: 1,
    pipelining: 1,
    amount: 1,
  });

  return {
    ...summary,
    extra: [
      ["url length", String(url.length) + " chars"],
      ["note", "single-request sample; rerun for a distribution"],
    ],
  };
}
