import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { bulkCreateCmd } from "../src/commands/bulk-create.js";
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, writeFile: vi.fn(actual.writeFile) };
});
const auth = { baseUrl: "https://mantis.example.com", key: "fake" };
let dir: string;
let errors: string[];
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mantis-bulk-recovery-test-"));
  errors = [];
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  vi.spyOn(process.stderr, "write").mockImplementation((x) => { errors.push(String(x)); return true; });
  vi.spyOn(process, "exit").mockImplementation((code) => { throw new Error(`exit ${code}`); });
  await writeFile(join(dir, "in.csv"), "memo\nfirst canary\nsecond canary\nthird canary\n");
});
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); process.exitCode = undefined; await rm(dir, { recursive: true, force: true }); });
function created(n: number) {
  return Response.json({ id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`, public_id: `pub${n}`, url: `https://mantis.example.com/c/pub${n}`, created_at: "2026-10-01T00:00:00Z", destinations: [] }, { status: 201 });
}

it("rejects an unavailable output directory before any remote creation", async () => {
  const fetch = vi.fn(async () => created(1));
  vi.stubGlobal("fetch", fetch);
  await expect(bulkCreateCmd({ ...auth, csv: join(dir, "in.csv"), out: join(dir, "missing", "out.csv") })).rejects.toThrow("exit 1");
  expect(fetch).not.toHaveBeenCalled();
});

it("retains a recovery CSV when the output destination disappears after creation", async () => {
  const outputDir = join(dir, "output");
  await mkdir(outputDir);
  let requests = 0;
  vi.stubGlobal("fetch", async () => {
    requests += 1;
    if (requests === 1) await rm(outputDir, { recursive: true });
    return created(requests);
  });
  await expect(bulkCreateCmd({ ...auth, csv: join(dir, "in.csv"), out: join(outputDir, "out.csv"), concurrency: "1" })).rejects.toThrow("exit 1");
  const recovery = /Completed mappings are saved at ([^;]+);/.exec(errors.join(""))?.[1];
  expect(recovery).toBeTruthy();
  const csv = await readFile(recovery!, "utf8");
  expect(requests).toBe(3);
  expect(csv).toContain("first canary");
  expect(csv).toContain("https://mantis.example.com/c/pub3");
  expect(errors.join("")).not.toContain("wrote 3/3");
  await rm(dirname(recovery!), { recursive: true });
});

it("drains in-flight creation on Ctrl-C and leaves unsent rows safe to identify", async () => {
  let requests = 0;
  vi.stubGlobal("fetch", async () => {
    requests += 1;
    process.emit("SIGINT");
    return created(requests);
  });
  const out = join(dir, "out.csv");
  await bulkCreateCmd({ ...auth, csv: join(dir, "in.csv"), out, concurrency: "1" });
  expect(requests).toBe(1);
  expect(process.exitCode).toBe(130);
  const csv = await readFile(out, "utf8");
  expect(csv).toContain("https://mantis.example.com/c/pub1");
  expect(csv).toContain("second canary");
  expect(csv).toContain("interrupted before creation; no request sent");
});

it("keeps interruption recovery active while the final output is being flushed", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  vi.stubGlobal("fetch", async () => created(1));
  const out = join(dir, "out.csv");
  vi.mocked(writeFile).mockImplementationOnce(async (path, data, options) => {
    expect(process.listenerCount("SIGINT")).toBeGreaterThan(0);
    process.emit("SIGINT");
    await new Promise((resolve) => setTimeout(resolve, 10));
    await actual.writeFile(path, data, options);
  });
  const before = process.listenerCount("SIGINT");
  await bulkCreateCmd({ ...auth, csv: join(dir, "in.csv"), out, concurrency: "1" });
  expect(process.exitCode).toBe(130);
  expect(await readFile(out, "utf8")).toContain("https://mantis.example.com/c/pub1");
  expect(errors.join("")).toContain("Recovery CSV:");
  expect(errors.join("")).toContain("confirmed mappings are saved at");
  expect(process.listenerCount("SIGINT")).toBe(before);
});
