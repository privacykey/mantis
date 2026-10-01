import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { statusCmd } from "../src/commands/status.js";
import { setJsonMode } from "../src/lib/out.js";

const auth = { baseUrl: "https://mantis.example.com", key: "fake", retries: "0" };
const key = { id: "00000000-0000-4000-8000-000000000001", public_id: "pub", monitor_mode: "latch", memo: "production" };
let output: string[];
beforeEach(() => {
  output = [];
  vi.spyOn(process.stdout, "write").mockImplementation((x) => { output.push(String(x)); return true; });
  vi.spyOn(process.stderr, "write").mockImplementation((x) => { output.push(String(x)); return true; });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); process.exitCode = undefined; setJsonMode(false); });

describe("monitor failure recovery", () => {
  it.each(["network", "http", "invalid"])("does not hide %s failures behind --tripped-only", async (failure) => {
    vi.stubGlobal("fetch", async (url: URL) => {
      if (url.pathname === "/api/keys") return Response.json({ data: [key], next_cursor: null });
      if (failure === "network") throw new Error("fetch failed");
      if (failure === "http") return Response.json({ error: "unavailable" }, { status: 503 });
      return Response.json({ wrong: "shape" });
    });
    await statusCmd(undefined, { ...auth, trippedOnly: true });
    expect(output.join("")).not.toContain("no monitored keys currently tripped");
    expect(output.join("")).toContain("production");
    expect(output.join("")).toContain("unavailable");
    expect(process.exitCode).toBe(1);
  });

  it("keeps an explicit error in JSON output while hiding known ok keys", async () => {
    setJsonMode(true);
    vi.stubGlobal("fetch", async (url: URL) => {
      if (url.pathname === "/api/keys") return Response.json({ data: [key, { ...key, id: "other", public_id: "healthy" }], next_cursor: null });
      if (url.pathname.endsWith("healthy")) return Response.json({ status: "ok" });
      throw new Error("fetch failed");
    });
    await statusCmd(undefined, { ...auth, trippedOnly: true });
    const result = JSON.parse(output.join(""));
    expect(result.keys).toHaveLength(1);
    expect(result.keys[0].state.status).toBe("error");
    expect(process.exitCode).toBe(1);
  });

  it("still shows an all-clear when every status was verified ok", async () => {
    vi.stubGlobal("fetch", async (url: URL) => url.pathname === "/api/keys"
      ? Response.json({ data: [key], next_cursor: null }) : Response.json({ status: "ok" }));
    await statusCmd(undefined, { ...auth, trippedOnly: true });
    expect(output.join("")).toContain("no monitored keys currently tripped");
    expect(process.exitCode ?? 0).toBe(0);
  });

  it("recognizes the intentional HTTP 503 response for a tripped monitor", async () => {
    vi.stubGlobal("fetch", async (url: URL) => url.pathname === "/api/keys"
      ? Response.json({ data: [key], next_cursor: null })
      : Response.json({ status: "tripped", tripped_at: "2026-10-01T00:00:00Z" }, { status: 503 }));
    await statusCmd(undefined, { ...auth, trippedOnly: true });
    expect(output.join("")).toContain("tripped");
    expect(output.join("")).not.toContain("unavailable");
    expect(process.exitCode ?? 0).toBe(0);
  });
});
