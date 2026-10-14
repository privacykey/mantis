import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { monitorCmd } from "../src/commands/monitor.js";
import { statusCmd } from "../src/commands/status.js";
import { setJsonMode } from "../src/lib/out.js";

const auth = { baseUrl: "https://mantis.example.com", key: "fake", retries: "0" };
const key = { id: "00000000-0000-4000-8000-000000000001", public_id: "pub", monitor_mode: "latch", memo: "production" };
const monitorPath = (id: string) => `/api/keys/${id}/monitor`;
const state = (s: "off" | "ok" | "tripped", trippedAt: string | null = null) =>
  Response.json({ state: s, tripped_at: trippedAt, mode: "latch", window_seconds: 300 });
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
      if (url.pathname === monitorPath("other")) return state("ok");
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
      ? Response.json({ data: [key], next_cursor: null }) : state("ok"));
    await statusCmd(undefined, { ...auth, trippedOnly: true });
    expect(output.join("")).toContain("no monitored keys currently tripped");
    expect(process.exitCode ?? 0).toBe(0);
  });

  it("reports a tripped monitor from the owner-gated route", async () => {
    vi.stubGlobal("fetch", async (url: URL) => url.pathname === "/api/keys"
      ? Response.json({ data: [key], next_cursor: null })
      : state("tripped", "2026-10-01T00:00:00Z"));
    await statusCmd(undefined, { ...auth, trippedOnly: true });
    expect(output.join("")).toContain("tripped");
    expect(output.join("")).toContain("2026-10-01T00:00:00Z");
    expect(output.join("")).not.toContain("unavailable");
    expect(process.exitCode ?? 0).toBe(0);
  });

  it("shows a monitor the server reports as off without calling it an error", async () => {
    vi.stubGlobal("fetch", async (url: URL) => url.pathname === "/api/keys"
      ? Response.json({ data: [key], next_cursor: null }) : state("off"));
    await statusCmd(undefined, auth);
    expect(output.join("")).toContain("off / not monitored");
    expect(process.exitCode ?? 0).toBe(0);
  });
});

// The public status URL is keyed by a capability only the server can mint
// (/status/<publicId>.<tag>); a bare /status/<publicId> answers 404. The CLI
// reads state through GET /api/keys/{id}/monitor and never builds a status URL.
describe("monitor state is read by key id through the API", () => {
  const statusUrl = "https://public.example.com/status/pub.Zm9vYmFyYmF6cXV4MTIzNDU2";
  const full = { ...key, monitor_window_seconds: 300, monitor_reset_at: null, monitor_status_url: statusUrl, destinations: [] };
  let paths: string[];
  const serve = (handler: (url: URL, method: string) => Response) => {
    paths = [];
    vi.stubGlobal("fetch", async (url: URL, init: RequestInit = {}) => {
      paths.push(url.pathname);
      return handler(url, (init.method ?? "GET").toUpperCase());
    });
  };
  const noStatusCalls = () => expect(paths.filter((p) => p.startsWith("/status"))).toEqual([]);

  it("status (summary)", async () => {
    serve((url) => url.pathname === "/api/keys" ? Response.json({ data: [full], next_cursor: null }) : state("ok"));
    await statusCmd(undefined, auth);
    expect(paths).toEqual(["/api/keys", monitorPath(key.id)]);
    noStatusCalls();
  });

  it("status <id> (detail) shows the server's status URL as-is", async () => {
    serve((url) => {
      if (url.pathname === `/api/keys/${key.id}`) return Response.json(full);
      if (url.pathname === monitorPath(key.id)) return state("tripped", "2026-10-01T00:00:00Z");
      return Response.json({ data: [], next_cursor: null });
    });
    await statusCmd(key.id, auth);
    expect(paths).toContain(monitorPath(key.id));
    noStatusCalls();
    expect(output.join("")).toContain(statusUrl);
    expect(output.join("")).toContain("tripped");
  });

  it("monitor --mode", async () => {
    serve((url, method) => method === "PATCH" ? Response.json(full) : state("ok"));
    await monitorCmd(key.id, { ...auth, mode: "latch" });
    expect(paths).toEqual([`/api/keys/${key.id}`, monitorPath(key.id)]);
    noStatusCalls();
    expect(output.join("")).toContain(statusUrl);
    expect(output.join("")).toContain("ok");
  });
});
