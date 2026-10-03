import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { forward } from "../src/forward";

// forward() runs inside ctx.waitUntil(), which Cloudflare lets continue for at
// most 30 s after the response is sent. A failed delivery is retried a small,
// bounded number of times inside that window; nothing queues it afterwards.

const WEBHOOK = "https://hooks.example.com/inbox";
const WAIT_UNTIL_LIMIT_MS = 30_000;

type Reply = Response | Error | "hang";

let calls: Array<{ at: number; body: string }> = [];
let started = 0;

function stubFetch(replies: Reply[]): void {
  const queue = [...replies];
  vi.stubGlobal(
    "fetch",
    vi.fn((_url: string, init: RequestInit) => {
      calls.push({ at: Date.now() - started, body: String(init.body) });
      const next = queue.length > 1 ? queue.shift()! : queue[0]!;
      if (next === "hang") {
        // Never answers; only the caller's abort signal ends it.
        return new Promise<Response>((_resolve, reject) => {
          init.signal!.addEventListener("abort", () =>
            reject(new DOMException("The operation was aborted", "AbortError")),
          );
        });
      }
      if (next instanceof Error) return Promise.reject(next);
      return Promise.resolve(next.clone());
    }),
  );
}

function status(code: number, headers: Record<string, string> = {}): Response {
  return new Response(null, { status: code, headers });
}

/** Run forward() to completion under fake timers; resolves to its error, if any. */
async function deliver(): Promise<{ error: Error | null; elapsed: number }> {
  let error: Error | null = null;
  const done = forward(
    { w: WEBHOOK },
    new Request("https://mantis-edge.example.workers.dev/c/blob"),
  ).catch((err: Error) => {
    error = err;
  });
  await vi.runAllTimersAsync();
  await done;
  return { error, elapsed: Date.now() - started };
}

beforeEach(() => {
  vi.useFakeTimers();
  calls = [];
  started = Date.now();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("forward retry", () => {
  it("delivers on the first attempt without waiting", async () => {
    stubFetch([status(200)]);
    const { error, elapsed } = await deliver();
    expect(error).toBeNull();
    expect(calls).toHaveLength(1);
    expect(elapsed).toBe(0);
  });

  it.each([429, 500, 502, 503, 504])("retries HTTP %i and delivers when it clears", async (code) => {
    stubFetch([status(code), status(204)]);
    const { error } = await deliver();
    expect(error).toBeNull();
    expect(calls).toHaveLength(2);
    expect(calls[1]!.at).toBeGreaterThanOrEqual(500);
  });

  it("retries a network error", async () => {
    stubFetch([new TypeError("fetch failed"), status(200)]);
    const { error } = await deliver();
    expect(error).toBeNull();
    expect(calls).toHaveLength(2);
  });

  it("retries a timeout", async () => {
    stubFetch(["hang", status(200)]);
    const { error } = await deliver();
    expect(error).toBeNull();
    expect(calls).toHaveLength(2);
    // First attempt was abandoned after the 5 s send timeout.
    expect(calls[1]!.at).toBeGreaterThanOrEqual(5000);
  });

  it("sends the identical body (same hit id) on every attempt", async () => {
    stubFetch([status(503), status(503), status(200)]);
    const { error } = await deliver();
    expect(error).toBeNull();
    expect(calls).toHaveLength(3);
    expect(new Set(calls.map((c) => c.body)).size).toBe(1);
    expect(JSON.parse(calls[0]!.body).hit.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("gives up after two retries", async () => {
    stubFetch([status(503)]);
    const { error } = await deliver();
    expect(calls).toHaveLength(3);
    expect(error?.message).toContain("HTTP 503");
    expect(error?.message).toContain("attempt 3");
  });

  it.each([400, 401, 403, 404, 410])("does not retry HTTP %i", async (code) => {
    stubFetch([status(code)]);
    const { error, elapsed } = await deliver();
    expect(calls).toHaveLength(1);
    expect(error?.message).toContain(`HTTP ${code}`);
    expect(elapsed).toBe(0);
  });

  it("refuses a redirect without retrying", async () => {
    stubFetch([status(302, { location: "https://elsewhere.example/" })]);
    const { error } = await deliver();
    expect(calls).toHaveLength(1);
    expect(error?.message).toBe("HTTP 302 redirect refused");
  });

  it("waits as long as a short Retry-After asks", async () => {
    stubFetch([status(429, { "retry-after": "2" }), status(200)]);
    const { error } = await deliver();
    expect(error).toBeNull();
    expect(calls).toHaveLength(2);
    expect(calls[1]!.at).toBe(2000);
  });

  it("understands fractional and HTTP-date Retry-After values", async () => {
    stubFetch([status(429, { "retry-after": "1.5" }), status(200)]);
    await deliver();
    expect(calls[1]!.at).toBe(1500);

    calls = [];
    started = Date.now();
    const at = new Date(started + 3000).toUTCString();
    stubFetch([status(503, { "retry-after": at }), status(200)]);
    await deliver();
    expect(calls).toHaveLength(2);
    // HTTP dates have one-second resolution.
    expect(calls[1]!.at).toBeGreaterThanOrEqual(2000);
    expect(calls[1]!.at).toBeLessThanOrEqual(3000);
  });

  it("does not retry early when the destination asks for a long wait", async () => {
    stubFetch([status(429, { "retry-after": "60" }), status(200)]);
    const { error, elapsed } = await deliver();
    expect(calls).toHaveLength(1);
    expect(error?.message).toContain("HTTP 429");
    expect(error?.message).toContain("not retried");
    expect(elapsed).toBe(0);
  });

  it("always finishes inside the waitUntil window, even when every attempt hangs", async () => {
    stubFetch(["hang"]);
    const { error, elapsed } = await deliver();
    expect(error).not.toBeNull();
    expect(calls).toHaveLength(3);
    expect(elapsed).toBeLessThan(WAIT_UNTIL_LIMIT_MS - 5000);
  });

  it("stays inside the window when slow failures and Retry-After waits combine", async () => {
    // Worst case: each attempt runs to its timeout… and when the destination
    // does answer, it asks for the longest wait we accept.
    stubFetch(["hang", status(503, { "retry-after": "5" }), "hang"]);
    const { error, elapsed } = await deliver();
    expect(error).not.toBeNull();
    expect(calls.length).toBeLessThanOrEqual(3);
    expect(elapsed).toBeLessThan(WAIT_UNTIL_LIMIT_MS - 5000);
  });
});
