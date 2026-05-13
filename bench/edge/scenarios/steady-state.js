/**
 * Steady-state: hammer a valid sealed URL at a fixed concurrency for the
 * configured duration. Webhook target is a black-hole address (127.0.0.1:1)
 * so `ctx.waitUntil` work doesn't get blocked on a real socket.
 */
import {
  mintEdgeUrl,
  resolveEdgeKey,
} from "../setup.js";
import { runAutocannon } from "./_lib.js";

export async function steadyState({
  workerUrl,
  durationSec,
  connections,
  pipelining,
}) {
  const keyRaw = resolveEdgeKey();
  const url = await mintEdgeUrl({
    workerUrl,
    webhook: "http://127.0.0.1:1/wh",
    responseKind: "empty",
    keyRaw,
  });

  const summary = await runAutocannon({
    url,
    durationSec,
    connections,
    pipelining,
  });

  return {
    ...summary,
    extra: [
      ["url length", String(url.length) + " chars"],
      ["target", url.replace(workerUrl, workerUrl + "")],
    ],
  };
}
