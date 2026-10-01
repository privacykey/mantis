import { beforeEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const fixtures = vi.hoisted(() => ({ lookup: vi.fn(), capture: vi.fn() }));
vi.mock("@/db/client", () => ({ db: { select: () => ({ from: () => ({ where: () => ({ limit: fixtures.lookup }) }) }) } }));
vi.mock("@/lib/log", () => ({ log: { error() {} } }));
vi.mock("@/lib/hits", () => ({ recordHitWithNotifications: fixtures.capture }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: () => ({ ok: true }) }));
import { GET, HEAD, POST } from "@/app/c/[publicId]/route";

beforeEach(() => { fixtures.lookup.mockReset(); fixtures.capture.mockReset(); });
const context = () => ({ params: Promise.resolve({ publicId: "valid123" }) });

it.each([GET, HEAD, POST])("returns a retryable failure when key lookup is unavailable", async (handler) => {
  fixtures.lookup.mockRejectedValueOnce(new Error("internal database details"));
  const response = await handler(new NextRequest("http://localhost/c/valid123"), context());
  expect(response.status).toBe(503);
  expect(response.headers.get("retry-after")).toBe("1");
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.text()).toBe("");
  expect(fixtures.capture).not.toHaveBeenCalled();
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
});
