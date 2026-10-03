import { beforeEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const fixtures = vi.hoisted(() => ({ lookup: vi.fn(), capture: vi.fn(), limit: vi.fn() }));
vi.mock("@/db/client", () => ({ db: { select: () => ({ from: () => ({ where: () => ({ limit: fixtures.lookup }) }) }) } }));
vi.mock("@/lib/log", () => ({ log: { error() {} } }));
vi.mock("@/lib/hits", () => ({ recordHitWithNotifications: fixtures.capture }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: fixtures.limit }));
import { DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT } from "@/app/c/[publicId]/route";
import * as appended from "@/app/c/[publicId]/[...rest]/route";

beforeEach(() => {
  fixtures.lookup.mockReset();
  fixtures.capture.mockReset();
  fixtures.limit.mockReset().mockReturnValue({ ok: true });
});
const context = () => ({ params: Promise.resolve({ publicId: "valid123" }) });
const liveKey = { id: "k1", publicId: "valid123", disabledAt: null, expiresAt: null, responseKind: "empty", responsePayload: null };

it.each([GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS])("returns a retryable failure when key lookup is unavailable", async (handler) => {
  fixtures.lookup.mockRejectedValueOnce(new Error("internal database details"));
  const response = await handler(new NextRequest("http://localhost/c/valid123"), context());
  expect(response.status).toBe(503);
  expect(response.headers.get("retry-after")).toBe("1");
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.text()).toBe("");
  expect(fixtures.capture).not.toHaveBeenCalled();
});

it.each([GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS])("captures a live key on the bare trigger URL whatever the method", async (handler) => {
  fixtures.lookup.mockResolvedValueOnce([liveKey]);
  const response = await handler(new NextRequest("http://localhost/c/valid123"), context());
  expect(response.status).toBe(204);
  expect(fixtures.capture).toHaveBeenCalledTimes(1);
  // No appended path on the bare URL.
  expect(fixtures.capture.mock.calls[0]![1].headers["x-mantis-request-path"]).toBeUndefined();
});

it.each([
  { rows: [] },
  { rows: [{ disabledAt: new Date(), expiresAt: null }] },
  { rows: [{ disabledAt: null, expiresAt: new Date(0) }] },
])("keeps unknown and inactive keys neutral", async ({ rows }) => {
  fixtures.lookup.mockResolvedValueOnce(rows);
  const response = await GET(new NextRequest("http://localhost/c/valid123"), context());
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("image/gif");
  expect(fixtures.capture).not.toHaveBeenCalled();
  // Nothing is charged to any limiter for a request that addresses no live key.
  expect(fixtures.limit).not.toHaveBeenCalled();
});

it.each(["x", "short", "has space", "a".repeat(33), "semi;colon1"])(
  "answers malformed id %j before any lookup or limiter accounting",
  async (publicId) => {
    const response = await GET(
      new NextRequest(`http://localhost/c/${encodeURIComponent(publicId)}`, { headers: { "x-forwarded-for": "203.0.113.9" } }),
      { params: Promise.resolve({ publicId }) },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/gif");
    expect(fixtures.lookup).not.toHaveBeenCalled();
    expect(fixtures.limit).not.toHaveBeenCalled();
    expect(fixtures.capture).not.toHaveBeenCalled();
  },
);

it("limits a live key per key (+IP) only — never by client IP alone", async () => {
  vi.stubEnv("TRUST_PROXY_HEADERS", "1");
  vi.stubEnv("TRUSTED_IP_HEADER", "x-forwarded-for");
  try {
    fixtures.lookup.mockResolvedValueOnce([liveKey]);
    await GET(new NextRequest("http://localhost/c/valid123", { headers: { "x-forwarded-for": "203.0.113.9" } }), context());
    expect(fixtures.limit.mock.calls.map((c) => c[0])).toEqual(["trigger:key:valid123:203.0.113.9"]);
    expect(fixtures.capture).toHaveBeenCalledTimes(1);
  } finally {
    vi.unstubAllEnvs();
  }
});

it("an over-cap live key still gets its own response, without recording", async () => {
  fixtures.lookup.mockResolvedValueOnce([liveKey]);
  fixtures.limit.mockReturnValue({ ok: false });
  const response = await GET(new NextRequest("http://localhost/c/valid123"), context());
  expect(response.status).toBe(204); // the key's "empty" response, not the GIF
  expect(fixtures.capture).not.toHaveBeenCalled();
});

it.each(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const)(
  "%s <trigger URL>/<appended path> goes through the same handler",
  async (method) => {
    const ctx = () => ({ params: Promise.resolve({ publicId: "valid123", rest: ["v1", "users"] }) });
    const request = () => new NextRequest("http://localhost/c/valid123/v1/users", { method });

    fixtures.lookup.mockRejectedValueOnce(new Error("internal database details"));
    const unavailable = await appended[method](request(), ctx());
    expect(unavailable.status).toBe(503);
    expect(unavailable.headers.get("retry-after")).toBe("1");

    fixtures.lookup.mockResolvedValueOnce([liveKey]);
    const response = await appended[method](request(), ctx());
    expect(response.status).toBe(204);
    expect(fixtures.capture).toHaveBeenCalledTimes(1);
    expect(fixtures.capture.mock.calls[0]![1].headers["x-mantis-request-path"]).toBe("/v1/users");
  },
);
