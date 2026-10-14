import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.XDG_CONFIG_HOME = "/nonexistent/mantis-cli-tests";
});

// The [y/N] prompt: answer from here, and record what was asked.
const prompt = vi.hoisted(() => ({ answer: "y", questions: [] as string[] }));
vi.mock("node:readline/promises", () => ({
  createInterface: () => ({
    question: async (q: string) => {
      prompt.questions.push(q);
      return prompt.answer;
    },
    close: () => {},
  }),
}));
vi.mock("../src/lib/prompt.js", async (original) => ({
  ...(await original<typeof import("../src/lib/prompt.js")>()),
  canPrompt: () => true,
}));

import { addDestinationCmd } from "../src/commands/destinations.js";
import { lastCmd } from "../src/commands/last.js";
import { rmCmd } from "../src/commands/rm.js";
import { disableCmd } from "../src/commands/toggle.js";
import { MantisClient } from "../src/lib/api.js";
import { ExitCode, setJsonMode } from "../src/lib/out.js";
import { resolveKeyRef } from "../src/lib/resolve.js";

const BASE = "https://mantis.example.com";
const auth = { baseUrl: BASE, key: "fake", retries: "0" };

function key(id: string, memo: string) {
  return {
    id,
    public_id: `pub${id.slice(0, 5)}`,
    url: `${BASE}/c/pub${id.slice(0, 5)}`,
    memo,
    destinations: [],
    disabled: false,
    disabled_at: null,
    expires_at: null,
  };
}
// The operator's key, and a newer one created by another credential (say, an
// enroll-scoped fleet key). An admin's unscoped listing puts the newer first.
const MINE = key("aaaa1111-0000-4000-8000-000000000001", "my canary");
const THEIRS = key("bbbb2222-0000-4000-8000-000000000002", "not yours");
// A key this same credential creates later, e.g. while a prompt is open.
const MINE_LATER = key("cccc3333-0000-4000-8000-000000000003", "created meanwhile");

type Call = { method: string; path: string; search: string };
let calls: Call[];
/** What happened in order: requests and stderr lines. */
let timeline: string[];
let stderr: string[];
let stdout: string[];
/** Newest-first keys created by the calling credential; tests may change it mid-run. */
let mine: ReturnType<typeof key>[];

beforeEach(() => {
  calls = [];
  timeline = [];
  stderr = [];
  stdout = [];
  mine = [MINE];
  prompt.answer = "y";
  prompt.questions.length = 0;
  vi.spyOn(process.stderr, "write").mockImplementation((x) => {
    stderr.push(String(x));
    timeline.push(`stderr ${String(x)}`);
    return true;
  });
  vi.spyOn(process.stdout, "write").mockImplementation((x) => {
    stdout.push(String(x));
    return true;
  });
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`exit ${code}`);
  }) as never);
  vi.stubGlobal("fetch", async (url: URL, init: RequestInit = {}) => {
    const method = (init.method ?? "GET").toUpperCase();
    calls.push({ method, path: url.pathname, search: url.search });
    timeline.push(`${method} ${url.pathname}${url.search}`);
    if (url.pathname === "/api/keys") {
      const all = [THEIRS, ...mine];
      const data = url.searchParams.get("mine") === "1" ? mine : all;
      const limit = Number(url.searchParams.get("limit") ?? "50");
      return Response.json({ data: data.slice(0, limit), next_cursor: null });
    }
    const id = url.pathname.split("/")[3]!;
    const found = [THEIRS, MINE, MINE_LATER].find((k) => k.id === id);
    if (!found) return Response.json({ error: "not_found" }, { status: 404 });
    if (method === "DELETE") return new Response(null, { status: 204 });
    return Response.json(found);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  setJsonMode(false);
  process.exitCode = undefined;
});

const listings = () => calls.filter((c) => c.method === "GET" && c.path === "/api/keys");
const deletes = () => calls.filter((c) => c.method === "DELETE").map((c) => c.path);

describe("`last` means the caller's own newest key", () => {
  it("resolveKeyRef asks the server for the caller's keys only", async () => {
    const client = new MantisClient({ baseUrl: BASE, key: "fake" });
    expect(await resolveKeyRef(client, "last")).toBe(MINE.id);
    expect(listings()).toHaveLength(1);
    expect(new URLSearchParams(listings()[0]!.search).get("mine")).toBe("1");
    expect(new URLSearchParams(listings()[0]!.search).get("limit")).toBe("1");
  });

  it("`mantis last` prints the caller's key, not the newest on the instance", async () => {
    await lastCmd(auth);
    expect(stdout.join("")).toBe(`${MINE.id}\n`);
    expect(new URLSearchParams(listings()[0]!.search).get("mine")).toBe("1");
  });

  it("says so when this credential has created nothing", async () => {
    mine = [];
    await expect(disableCmd(["last"], auth)).resolves.toBeUndefined();
    expect(stderr.join("")).toContain("has not created any keys yet");
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);

    const client = new MantisClient({ baseUrl: BASE, key: "fake" });
    await expect(resolveKeyRef(client, "last")).rejects.toThrow("has not created any keys yet");
  });
});

describe("acting on a symbolic ref names the key first", () => {
  it("dest add last: prints the resolved id and memo before changing the key", async () => {
    await addDestinationCmd("last", "webhook", "https://hooks.example.com/x", auth);

    const announced = timeline.findIndex(
      (e) => e.startsWith("stderr") && e.includes(MINE.id) && e.includes("my canary"),
    );
    const patched = timeline.findIndex((e) => e === `PATCH /api/keys/${MINE.id}`);
    expect(announced).toBeGreaterThanOrEqual(0);
    expect(patched).toBeGreaterThan(announced);
    expect(calls.some((c) => c.path.includes(THEIRS.id))).toBe(false);
  });

  it("disable <prefix>: a prefix is announced too", async () => {
    await disableCmd(["aaaa"], auth);
    expect(stderr.join("")).toContain(`aaaa → ${MINE.id} (my canary)`);
    expect(calls.some((c) => c.method === "PATCH" && c.path === `/api/keys/${MINE.id}`)).toBe(true);
  });

  it("a full UUID is not announced (nothing was looked up)", async () => {
    await disableCmd([MINE.id], auth);
    expect(stderr.join("")).not.toContain("→");
  });

  it("under --json the announcement is a JSON line on stderr", async () => {
    setJsonMode(true);
    await disableCmd(["last"], auth);
    expect(JSON.parse(stderr.join("").trim())).toEqual({
      resolved: { ref: "last", id: MINE.id, memo: "my canary" },
    });
    expect(JSON.parse(stdout.join("")).results).toEqual([{ ref: "last", id: MINE.id, ok: true }]);
  });
});

describe("rm deletes exactly what it showed", () => {
  it("resolves `last` once: a key created while the prompt is open is not deleted instead", async () => {
    const realAnswer = prompt.answer;
    // The operator reads the prompt; meanwhile the same credential mints a key.
    Object.defineProperty(prompt, "answer", {
      configurable: true,
      get() {
        mine = [MINE_LATER, MINE];
        return realAnswer;
      },
    });
    try {
      await rmCmd(["last"], auth);
    } finally {
      Object.defineProperty(prompt, "answer", { configurable: true, writable: true, value: realAnswer });
    }

    expect(prompt.questions).toHaveLength(1);
    expect(prompt.questions[0]).toContain(MINE.id);
    expect(prompt.questions[0]).toContain("my canary");
    expect(deletes()).toEqual([`/api/keys/${MINE.id}`]);
    expect(listings()).toHaveLength(1);
  });

  it("-y: announces the key `last` picked, then deletes that one", async () => {
    await rmCmd(["last"], { ...auth, yes: true });
    expect(prompt.questions).toHaveLength(0);
    const announced = timeline.findIndex((e) => e.startsWith("stderr") && e.includes(`last → ${MINE.id}`));
    const deleted = timeline.findIndex((e) => e === `DELETE /api/keys/${MINE.id}`);
    expect(announced).toBeGreaterThanOrEqual(0);
    expect(deleted).toBeGreaterThan(announced);
    expect(listings()).toHaveLength(1);
  });

  it("a batch lists every resolved id with its memo and deletes only those", async () => {
    await rmCmd(["last", THEIRS.id, "ffff"], auth);

    const shown = stderr.join("");
    expect(shown).toContain(`${MINE.id}  my canary`);
    expect(shown).toContain(`${THEIRS.id}  not yours`);
    expect(shown).toContain("ffff: no key matches prefix");
    expect(prompt.questions[0]).toContain("these 2 keys");
    expect(deletes()).toEqual([`/api/keys/${MINE.id}`, `/api/keys/${THEIRS.id}`]);
    expect(process.exitCode).toBe(1);
  });

  it("answering no deletes nothing", async () => {
    prompt.answer = "n";
    await expect(rmCmd(["last"], auth)).rejects.toThrow("exit");
    // "cancelled" exits 0; the mocked exit throws, so only the first call counts.
    expect(vi.mocked(process.exit).mock.calls[0]).toEqual([0]);
    expect(deletes()).toEqual([]);
  });

  it("a lone unknown id still fails with the not-found exit code", async () => {
    await expect(rmCmd(["dddd4444-0000-4000-8000-000000000004"], auth)).rejects.toThrow(
      `exit ${ExitCode.NotFound}`,
    );
    expect(prompt.questions).toHaveLength(0);
    expect(deletes()).toEqual([]);
  });
});
