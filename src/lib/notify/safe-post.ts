import { createHmac } from "node:crypto";
import { Agent, fetch as undiciFetch } from "undici";
import { assertSafeWebhookUrl, safeLookup, UnsafeUrlError } from "@/lib/ssrf";
import { isSelfTarget, SELF_DESTINATION } from "./self-target";

const DEFAULT_TIMEOUT_MS = 5000;

// Dispatcher whose connector re-validates the resolved address at connect
// time. Combined with the pre-flight `assertSafeWebhookUrl`, this closes the
// DNS-rebinding TOCTOU window — undici connects only to an address we just
// confirmed is public. Uses undici's own fetch (not the global, which Next
// may patch) so the dispatcher is honoured.
const safeDispatcher = new Agent({
  connect: { lookup: safeLookup },
});

export type SafePostOpts = {
  signingSecret?: string | null;
  userAgent?: string;
  timeoutMs?: number;
  deliveryId?: string;
};

/**
 * Shared outbound POST for webhook-shaped channels. http(s) only, never to
 * this instance itself, with a pre-flight DNS reject of private / metadata /
 * loopback addresses (unless ALLOW_PRIVATE_WEBHOOKS=1), redirect: manual, and
 * optional HMAC-SHA256 signing. One deadline (5 s by default) covers the DNS
 * pre-flight and the request together.
 */
export async function safePostJson(
  url: string,
  body: unknown,
  opts: SafePostOpts = {},
): Promise<void> {
  // Checked again here, not only when the destination is saved: rows stored
  // before the check existed, or under a different PUBLIC_BASE_URL, still land
  // on this path.
  if (isSelfTarget(url)) throw new UnsafeUrlError(SELF_DESTINATION);

  const bodyStr = JSON.stringify(body);
  const timestamp = String(Math.floor(Date.now() / 1000));

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": opts.userAgent ?? "mantis-webhook/0.13",
    "X-Mantis-Timestamp": timestamp,
  };
  if (opts.deliveryId) {
    headers["X-Mantis-Delivery-Id"] = opts.deliveryId;
    headers["Idempotency-Key"] = opts.deliveryId;
  }
  if (opts.signingSecret) {
    const sig = createHmac("sha256", opts.signingSecret)
      .update(`${timestamp}.${bodyStr}`)
      .digest("hex");
    headers["X-Mantis-Signature"] = `sha256=${sig}`;
  }

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  try {
    // The pre-flight resolves a hostname the destination's creator chose, and
    // dns.lookup has no timeout of its own. It runs under the same deadline as
    // the request so a slow resolver cannot hold a delivery (and the worker
    // batch waiting on it) for longer than the documented timeout.
    await beforeAbort(assertSafeWebhookUrl(url), controller.signal);

    const res = await undiciFetch(url, {
      method: "POST",
      headers,
      body: bodyStr,
      signal: controller.signal,
      redirect: "manual",
      dispatcher: safeDispatcher,
    });
    if (res.status >= 300 && res.status < 400) {
      // Status and Location ORIGIN only. A redirect commonly repeats the
      // request path or query (http → https, trailing slash), and for a
      // webhook that path is the credential; the error text is stored in
      // notifications.last_error and shown with the hit.
      throw new Error(
        `HTTP ${res.status} redirect to ${redirectOrigin(res.headers.get("location"), url)} — refusing to follow`,
      );
    }
    if (!res.ok) {
      // Status line only — never echo the target's response body into the
      // error. It surfaces to the key owner via notifications.last_error, and
      // paired with any SSRF gap would turn the sender into an internal-
      // response oracle.
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

/** Settles with `work`, or rejects as soon as `signal` aborts — whichever is first. */
function beforeAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }
    // An abandoned lookup still settles here later; that late result is ignored.
    work
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", onAbort));
  });
}

function redirectOrigin(location: string | null, base: string): string {
  if (!location) return "?";
  try {
    const origin = new URL(location, base).origin;
    return origin === "null" ? "(non-http location)" : origin;
  } catch {
    return "(invalid location)";
  }
}
