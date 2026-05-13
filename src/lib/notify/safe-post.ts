import { createHmac } from "node:crypto";
import { assertSafeWebhookUrl } from "@/lib/ssrf";

const DEFAULT_TIMEOUT_MS = 5000;

export type SafePostOpts = {
  signingSecret?: string | null;
  userAgent?: string;
  timeoutMs?: number;
  /**
   * Echo up to 200 chars of the response body into the thrown error. Off by
   * default — leaks response previews into the caller, useful as an
   * internal-service probe. Only safe on paths that log the error
   * internally and never surface it via the API.
   */
  includeBodyInError?: boolean;
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
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: bodyStr,
      signal: controller.signal,
      redirect: "manual",
    });
    if (res.status >= 300 && res.status < 400) {
      throw new Error(
        `HTTP ${res.status} redirect to ${res.headers.get("location") ?? "?"} — refusing to follow`,
      );
    }
    if (!res.ok) {
      if (opts.includeBodyInError) {
        const text = await res.text().catch(() => "");
        throw new Error(
          `HTTP ${res.status} ${res.statusText}${text ? `: ${text.slice(0, 200)}` : ""}`,
        );
      }
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }
  } finally {
    clearTimeout(timer);
  }
}
