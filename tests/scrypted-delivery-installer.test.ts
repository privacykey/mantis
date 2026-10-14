import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { buildInstaller } from "@mantis/core/installers";

type Listener = (source: unknown, details: unknown, data: unknown) => Promise<void>;
type DeliveryFetch = (url: string, init: RequestInit) => Promise<Response>;

function runInstaller(fetch: DeliveryFetch) {
  let listener: Listener | undefined;
  const log = vi.fn();
  const warn = vi.fn();
  const installer = buildInstaller("scrypted", {
    url: "https://mantis.example/c/scrypted-test",
    keyId: "00000000-0000-0000-0000-000000000001",
    memo: "front door camera",
  });
  runInNewContext(installer.content, {
    systemManager: {
      getDeviceById: () => ({
        listen: (_options: unknown, callback: Listener) => { listener = callback; },
      }),
    },
    fetch,
    AbortSignal,
    console: { log, warn },
  });
  if (!listener) throw new Error("Installer did not register its device listener");
  return { emit: (data: unknown) => listener!(null, null, data), log, warn };
}

function expectAccepted(log: ReturnType<typeof vi.fn>, warn: ReturnType<typeof vi.fn>) {
  expect(log).toHaveBeenCalledWith("Mantis fired", "person-detected", "front-door-camera");
  expect(warn).not.toHaveBeenCalled();
}

function expectFailed(log: ReturnType<typeof vi.fn>, warn: ReturnType<typeof vi.fn>) {
  expect(log.mock.calls.some(([message]) => message === "Mantis fired")).toBe(false);
  expect(warn).toHaveBeenCalledWith("Mantis fire failed", expect.anything());
}

describe("generated Scrypted installer delivery", () => {
  it.each([200, 204])("reports delivery after an accepted HTTP %i", async (status) => {
    const fetch = vi.fn<DeliveryFetch>().mockResolvedValue(new Response(null, { status }));
    const { emit, log, warn } = runInstaller(fetch);

    await emit(true);

    expectAccepted(log, warn);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("https://mantis.example/c/scrypted-test");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({
      "X-Mantis-Source": "scrypted",
      "X-Mantis-Event": "person-detected",
      "X-Mantis-Device": "front-door-camera",
      "X-Mantis-Entity-Id": "front-door-camera-smart-motion",
      "X-Mantis-Area": "front door",
    });
    expect(JSON.parse(String(init.body))).toMatchObject({ event: "person-detected", data: true });
  });

  it("accepts redirect headers without following their target", async () => {
    const fetch = vi.fn<DeliveryFetch>().mockResolvedValue(new Response(null, {
      status: 302,
      headers: { Location: "https://redirect.example/target" },
    }));
    const { emit, log, warn } = runInstaller(fetch);

    await emit(true);

    expectAccepted(log, warn);
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]![1].redirect).toBe("manual");
  });

  it.each([404, 503])("reports failed delivery after HTTP %i", async (status) => {
    const fetch = vi.fn<DeliveryFetch>().mockResolvedValue(new Response(null, { status }));
    const { emit, log, warn } = runInstaller(fetch);

    await emit(true);

    expectFailed(log, warn);
    expect(warn.mock.calls[0]![1].message).toBe(`HTTP ${status}`);
  });

  it("reports network rejection without claiming delivery", async () => {
    const error = new TypeError("network unavailable");
    const { emit, log, warn } = runInstaller(vi.fn<DeliveryFetch>().mockRejectedValue(error));

    await emit(true);

    expectFailed(log, warn);
    expect(warn).toHaveBeenCalledWith("Mantis fire failed", error);
  });

  it("aborts a stalled request at the generated ten-second deadline", async () => {
    let signal: AbortSignal | undefined;
    const fetch = vi.fn<DeliveryFetch>().mockImplementation((_url, init) => {
      signal = init.signal ?? undefined;
      if (!signal) throw new Error("Delivery request has no deadline signal");
      return new Promise<Response>((_resolve, reject) => {
        signal!.addEventListener("abort", () => reject(signal!.reason), { once: true });
      });
    });
    const { emit, log, warn } = runInstaller(fetch);
    const started = performance.now();

    await emit(true);

    expect(performance.now() - started).toBeLessThan(11_500);
    expect(signal?.aborted).toBe(true);
    expectFailed(log, warn);
    expect(warn.mock.calls[0]![1].name).toBe("TimeoutError");
  }, 12_000);

  it.each([false, "false", "off"])("keeps inactive device event %j silent", async (data) => {
    const fetch = vi.fn<DeliveryFetch>().mockResolvedValue(new Response(null, { status: 204 }));
    const { emit, log, warn } = runInstaller(fetch);

    await emit(data);

    expect(fetch).not.toHaveBeenCalled();
    expect(log.mock.calls.some(([message]) => message === "Mantis fired")).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });
});
