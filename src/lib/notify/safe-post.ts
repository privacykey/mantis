import { createHmac } from "node:crypto";
import { Agent, fetch as undiciFetch } from "undici";
import { assertSafeWebhookUrl, safeLookup } from "@/lib/ssrf";

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
};

/**
 * Shared outbound POST for webhook-shaped channels. http(s) only with a
 * pre-flight DNS reject of private / metadata / loopback addresses (unless
 * ALLOW_PRIVATE_WEBHOOKS=1), redirect: manual, 5 s default timeout, and
 * optional HMAC-SHA256 signing.
 */
export async function safePostJson(
  url: string,
  body: unknown,
  opts: SafePostOpts = {},
): Promise<void> {
  await assertSafeWebhookUrl(url);

  const bodyStr = JSON.stringify(body);
  const timestamp = String(Math.floor(Date.now() / 1000));

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": opts.userAgent ?? "mantis-webhook/0.13",
    "X-Mantis-Timestamp": timestamp,
  };
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
    const res = await undiciFetch(url, {
      method: "POST",
      headers,
      body: bodyStr,
      signal: controller.signal,
      redirect: "manual",
      dispatcher: safeDispatcher,
    });
    if (res.status >= 300 && res.status < 400) {
      throw new Error(
        `HTTP ${res.status} redirect to ${res.headers.get("location") ?? "?"} — refusing to follow`,
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
