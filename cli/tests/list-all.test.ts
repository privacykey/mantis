import { afterEach, expect, it, vi } from "vitest";
import { listCmd } from "../src/commands/list.js";
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("--all drains more than 1000 keys without duplicates", async () => {
  const output: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((x) => { output.push(String(x)); return true; });
  vi.stubGlobal("fetch", async (url: URL) => {
    const start = Number(url.searchParams.get("cursor") ?? "0");
    const count = Math.min(Number(url.searchParams.get("limit")), 1201 - start);
    return Response.json({ data: Array.from({ length: count }, (_, i) => ({ id: `key-${start + i}` })), next_cursor: start + count < 1201 ? String(start + count) : null });
  });
  await listCmd({ baseUrl: "https://mantis.example.com", key: "fake", all: true, idOnly: true });
  const ids = output.join("").trim().split("\n");
  expect(ids).toHaveLength(1201);
  expect(new Set(ids).size).toBe(1201);
});
