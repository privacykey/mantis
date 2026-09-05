import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { b64urlEncode, seal } from "../src/seal";
import type { Payload } from "../src/types";

const key = new Uint8Array(32).fill(7);
const env = { MANTIS_EDGE_KEY: b64urlEncode(key) };

async function request(payload: Payload): Promise<Request> {
  const blob = await seal(new TextEncoder().encode(JSON.stringify(payload)), key);
  return new Request(`https://edge.example.com/c/${b64urlEncode(blob)}`);
}

async function fire(req: Request, allowlist?: string) {
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => pending.push(p) } as unknown as ExecutionContext;
  const response = await worker.fetch(req, { ...env, MANTIS_EDGE_WEBHOOK_ALLOWLIST: allowlist }, ctx);
  await Promise.all(pending);
  return response;
}

describe("encrypted edge URL handling", () => {
  afterEach(() => vi.restoreAllMocks());

  it("forwards a valid URL and returns an uncached GIF", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null));
    const res = await fire(await request({ w: "https://hooks.example.com/test" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/gif");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("does not forward an expired URL", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null));
    const res = await fire(await request({ w: "https://hooks.example.com/test", exp: 1 }));
    expect(res.status).toBe(404);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["http://[", ", ,", "other.example.com"])("fails closed for allowlist %j", async (allowlist) => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await fire(await request({ w: "https://hooks.example.com/test" }), allowlist);
    expect(res.status).toBe(404);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["hooks.example.com", "*.example.com"])("honors allowlist %j", async (allowlist) => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null));
    const res = await fire(await request({ w: "https://hooks.example.com/test" }), allowlist);
    expect(res.status).toBe(200);
    expect(fetch).toHaveBeenCalledOnce();
  });
});
