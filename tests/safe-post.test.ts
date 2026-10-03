import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// safePostJson with the resolver and the HTTP client stubbed. The real-socket
// behaviour (SSRF refusal through the undici dispatcher, HMAC, no body
// oracle) is covered by tests/integration/outbound-ssrf.test.ts.

const net = vi.hoisted(() => ({ lookup: vi.fn(), fetch: vi.fn() }));

vi.mock("node:dns/promises", () => ({ lookup: net.lookup }));
vi.mock("undici", () => ({
  Agent: class {},
  fetch: (...args: unknown[]) => net.fetch(...args),
}));

import { safePostJson } from "@/lib/notify/safe-post";
import { SELF_DESTINATION } from "@/lib/notify/self-target";

function response(status: number, headers: Record<string, string> = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    statusText: "",
    headers: new Headers(headers),
  };
}

beforeEach(() => {
  net.lookup.mockReset().mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
  net.fetch.mockReset().mockResolvedValue(response(200));
});

describe("delivery deadline", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Starts a delivery and reports whether it has settled yet. */
  function start(url: string, timeoutMs: number) {
    const state = { settled: false, error: undefined as unknown };
    void safePostJson(url, {}, { timeoutMs }).then(
      () => {
        state.settled = true;
      },
      (err: unknown) => {
        state.settled = true;
        state.error = err;
      },
    );
    return state;
  }

  it("covers the DNS pre-flight, not just the request", async () => {
    // A resolver that never answers: dns.lookup has no timeout of its own.
    net.lookup.mockReturnValue(new Promise(() => {}));
    const delivery = start("https://slow-dns.example/hook", 5000);

    await vi.advanceTimersByTimeAsync(4999);
    expect(delivery.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(delivery.settled).toBe(true);
    expect(delivery.error).toBeInstanceOf(Error);
    expect(net.fetch).not.toHaveBeenCalled();
  });

  it("gives the request only what the pre-flight left of the deadline", async () => {
    net.lookup.mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(() => resolve([{ address: "93.184.216.34", family: 4 }]), 2000),
        ),
    );
    // A tarpit: settles only when the caller's signal aborts.
    net.fetch.mockImplementation(
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () => reject(init.signal.reason));
        }),
    );
    const delivery = start("https://tarpit.example/hook", 5000);

    await vi.advanceTimersByTimeAsync(2000);
    expect(net.fetch).toHaveBeenCalledTimes(1);
    // One 5 s budget for both phases — not 2 s of DNS plus a fresh 5 s.
    await vi.advanceTimersByTimeAsync(2999);
    expect(delivery.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(delivery.settled).toBe(true);
    expect(delivery.error).toBeInstanceOf(Error);
  });

  it("does not turn a late resolver error into an unhandled rejection", async () => {
    let failLookup!: (err: Error) => void;
    net.lookup.mockReturnValue(
      new Promise((_resolve, reject) => {
        failLookup = reject;
      }),
    );
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const delivery = start("https://slow-dns.example/hook", 5000);
      await vi.advanceTimersByTimeAsync(5000);
      expect(delivery.settled).toBe(true);

      failLookup(new Error("getaddrinfo EAI_AGAIN slow-dns.example"));
      vi.useRealTimers();
      await new Promise((r) => setTimeout(r, 20));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });
});

describe("redirect reporting", () => {
  // A redirect usually repeats the request path (http → https, trailing
  // slash), and for a webhook the path is the credential. The error is stored
  // in notifications.last_error.
  it("names the status and the Location origin only", async () => {
    net.fetch.mockResolvedValue(
      response(308, {
        location: "https://ha.example.net/api/webhook/super-secret-id?token=abc",
      }),
    );
    const err = await safePostJson("http://ha.example.net/api/webhook/super-secret-id", {})
      .catch((e: unknown) => e as Error);
    expect((err as Error).message).toBe(
      "HTTP 308 redirect to https://ha.example.net — refusing to follow",
    );
  });

  it("resolves a relative Location against the target, still origin only", async () => {
    net.fetch.mockResolvedValue(response(301, { location: "/api/webhook/super-secret-id/" }));
    const err = await safePostJson("https://ha.example.net/api/webhook/super-secret-id", {})
      .catch((e: unknown) => e as Error);
    expect((err as Error).message).toBe(
      "HTTP 301 redirect to https://ha.example.net — refusing to follow",
    );
  });

  it("copes with a missing or non-http Location", async () => {
    net.fetch.mockResolvedValue(response(302));
    await expect(safePostJson("https://x.example/hook", {})).rejects.toThrow(
      "HTTP 302 redirect to ? — refusing to follow",
    );
    net.fetch.mockResolvedValue(response(302, { location: "javascript:alert(document.cookie)" }));
    const err = await safePostJson("https://x.example/hook", {}).catch((e: unknown) => e as Error);
    expect((err as Error).message).not.toContain("alert");
  });
});

describe("self-targeting", () => {
  it("refuses to POST to this instance's own trigger URL, before any DNS or request", async () => {
    await expect(
      safePostJson("http://localhost:3000/c/AbCdEf1234", { type: "mantis.hit" }),
    ).rejects.toThrow(SELF_DESTINATION);
    expect(net.lookup).not.toHaveBeenCalled();
    expect(net.fetch).not.toHaveBeenCalled();
  });
});
