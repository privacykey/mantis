import { beforeEach, describe, expect, it, vi } from "vitest";
const fixtures = vi.hoisted(() => ({ lookup: vi.fn(), compute: vi.fn() }));
vi.mock("@/lib/log", () => ({ log: { error() {} } }));
vi.mock("@/db/client", () => ({ db: { select: () => ({ from: () => ({ where: () => ({ limit: fixtures.lookup }) }) }) } }));
vi.mock("@/lib/monitor", () => ({ computeMonitorState: fixtures.compute }));
import { NextRequest } from "next/server";
import { GET } from "@/app/status/[publicId]/route";
import { statusTag } from "@/lib/env";
import { proxy } from "@/proxy";

const read = (token: string) => GET({} as never, { params: Promise.resolve({ publicId: token }) });
const TOKEN = `valid123.${statusTag("valid123")}`;

beforeEach(() => {
  fixtures.lookup.mockReset().mockResolvedValue([{ monitorMode: "latch" }]);
  fixtures.compute.mockReset().mockResolvedValue({ kind: "ok" });
});

describe("monitor unavailability", () => {
  it.each(["lookup", "compute"] as const)("reports %s outage separately from disabled and tripped", async (stage) => {
    fixtures[stage].mockRejectedValueOnce(new Error("internal database details"));
    const response = await read(TOKEN);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "unavailable" });
    expect(response.headers.get("cache-control")).toContain("no-store");
  });
});

// The public id is the bait: it is in every trigger URL. Reading the monitor
// takes the tag that only statusUrl() can mint.
describe("status capability", () => {
  it("serves the state to the tagged URL, without timestamps or mode", async () => {
    fixtures.compute.mockResolvedValue({ kind: "tripped", trippedAt: new Date() });
    const response = await read(TOKEN);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: "tripped" });
  });

  it.each([
    ["the bare public id", "valid123"],
    ["a wrong tag", `valid123.${statusTag("other456")}`],
    ["a truncated tag", TOKEN.slice(0, -1)],
    ["an over-long tag", `${TOKEN}A`],
    ["an empty tag", "valid123."],
    ["a tag for a malformed id", `bad id!.${statusTag("bad id!")}`],
  ])("answers %s like a path that does not exist, without touching the database", async (_label, token) => {
    const response = await read(token);
    expect(response.status).toBe(404);
    // Byte-identical to the proxy's 404 for a blocked path: no body, and
    // nothing in the headers that says "Mantis status route".
    expect(await response.text()).toBe("");
    expect([...response.headers.entries()]).toEqual([["cache-control", "no-store"]]);
    expect(fixtures.lookup).not.toHaveBeenCalled();
    expect(fixtures.compute).not.toHaveBeenCalled();
  });

  // What the handler returns. On the wire Next still adds its app-router
  // `Vary` header to this response and not to the proxy's own.
  it("returns the response the proxy returns for a blocked path on a public-only host", async () => {
    const saved = process.env.PUBLIC_ONLY_HOSTS;
    process.env.PUBLIC_ONLY_HOSTS = "public.mantis.test";
    try {
      const blocked = proxy(
        new NextRequest("http://public.mantis.test/keys", { headers: { host: "public.mantis.test" } }),
      );
      const refused = await read("valid123");
      expect(refused.status).toBe(blocked.status);
      expect(await refused.text()).toBe(await blocked.text());
      expect([...refused.headers.entries()]).toEqual([...blocked.headers.entries()]);
    } finally {
      if (saved === undefined) delete process.env.PUBLIC_ONLY_HOSTS;
      else process.env.PUBLIC_ONLY_HOSTS = saved;
    }
  });

  it.each([
    ["an unknown key", [], { kind: "ok" }],
    ["a key whose monitor is off", [{ monitorMode: "off" }], { kind: "off" }],
  ])("answers %s with the same body-less 404, even with a valid tag", async (_label, rows, state) => {
    fixtures.lookup.mockResolvedValue(rows);
    fixtures.compute.mockResolvedValue(state);
    const response = await read(TOKEN);
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("");
    expect([...response.headers.entries()]).toEqual([["cache-control", "no-store"]]);
  });
});
