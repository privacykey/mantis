import { describe, expect, it, vi } from "vitest";
const fixtures = vi.hoisted(() => ({ lookup: vi.fn(), compute: vi.fn() }));
vi.mock("@/lib/log", () => ({ log: { error() {} } }));
vi.mock("@/db/client", () => ({ db: { select: () => ({ from: () => ({ where: () => ({ limit: fixtures.lookup }) }) }) } }));
vi.mock("@/lib/monitor", () => ({ computeMonitorState: fixtures.compute }));
import { GET } from "@/app/status/[publicId]/route";

describe("monitor unavailability", () => {
  it.each(["lookup", "compute"] as const)("reports %s outage separately from disabled and tripped", async (stage) => {
    fixtures.lookup.mockResolvedValue([{ monitorMode: "latch" }]);
    fixtures.compute.mockResolvedValue({ kind: "ok" });
    fixtures[stage].mockRejectedValueOnce(new Error("internal database details"));
    const response = await GET({} as never, { params: Promise.resolve({ publicId: "valid123" }) });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "unavailable" });
    expect(response.headers.get("cache-control")).toContain("no-store");
  });
});
