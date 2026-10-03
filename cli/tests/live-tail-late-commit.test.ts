import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.XDG_CONFIG_HOME = "/nonexistent/mantis-cli-tests";
});

import { hitsCmd } from "../src/commands/hits.js";
import { watchCmd } from "../src/commands/watch.js";
import { setJsonMode } from "../src/lib/out.js";

const KEY_ID = "00000000-0000-4000-8000-00000000000a";
const auth = { baseUrl: "https://mantis.example.com", key: "fake", retries: "0" };

const T0 = Date.parse("2026-09-01T10:00:00.000Z");
const at = (ms: number) => new Date(T0 + ms).toISOString();

function hit(id: string, occurredAt: string) {
  return {
    id,
    key: { id: KEY_ID, public_id: "pubAAAA1", memo: "prod" },
    occurred_at: occurredAt,
    ip: "203.0.113.7",
    user_agent: "curl/8",
    referer: null,
    headers: null,
    ua_browser: null,
    ua_browser_version: null,
    ua_os: null,
    ua_device: null,
    bot_label: null,
    is_duplicate: false,
    host_context: null,
    notifications: [],
  };
}

// occurred_at is stamped when a capture starts; the row is only visible once
// it commits. A started first (+3s) but commits after B (+5s) — and after a
// poll has already returned B.
const A = hit("hit-A-started-first", at(3_000));
const B = hit("hit-B-committed-first", at(5_000));

let stdout: string[];
let sigintBefore: NodeJS.SignalsListener[];

beforeEach(() => {
  stdout = [];
  vi.spyOn(process.stdout, "write").mockImplementation((x) => {
    stdout.push(String(x));
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  setJsonMode(true); // NDJSON: one hit per line, ids included
  vi.useFakeTimers();
  sigintBefore = process.listeners("SIGINT") as NodeJS.SignalsListener[];
});

afterEach(() => {
  for (const l of process.listeners("SIGINT")) {
    if (!sigintBefore.includes(l as NodeJS.SignalsListener)) {
      process.removeListener("SIGINT", l as NodeJS.SignalsListener);
    }
  }
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  setJsonMode(false);
});

/**
 * A stand-in for GET /api/hits/recent that filters like the server does
 * (strictly occurred_at > since) and only "commits" A from the third poll on.
 */
function stubFeed(): { polls: () => number; sinces: string[] } {
  let polls = 0;
  const sinces: string[] = [];
  vi.stubGlobal("fetch", async (url: URL) => {
    if (url.searchParams.get("anchor") === "1") {
      return Response.json({ data: [], next_cursor: null, server_time: at(0) });
    }
    polls += 1;
    const since = url.searchParams.get("since")!;
    sinces.push(since);
    const visible = polls >= 3 ? [B, A] : [B]; // newest first
    return Response.json({
      data: visible.filter((h) => Date.parse(h.occurred_at) > Date.parse(since)),
      next_cursor: null,
    });
  });
  return { polls: () => polls, sinces };
}

async function until(done: () => boolean): Promise<void> {
  for (let i = 0; i < 400 && !done(); i++) {
    await vi.advanceTimersByTimeAsync(250);
  }
  expect(done()).toBe(true);
}

function emittedIds(): string[] {
  return stdout
    .join("")
    .split("\n")
    .filter(Boolean)
    .map((line) => (JSON.parse(line) as { id: string }).id);
}

describe.each([
  ["watch", () => watchCmd({ ...auth, interval: "1" })],
  ["hits --follow", () => hitsCmd(KEY_ID, { ...auth, follow: true, interval: "1" })],
] as const)("%s", (_name, start) => {
  it("prints a hit that became visible after a later-timestamped hit was returned", async () => {
    const feed = stubFeed();

    const run = start();
    await until(() => feed.polls() >= 5);
    process.emit("SIGINT");
    await vi.advanceTimersByTimeAsync(2_000);
    await run;

    // Both hits, each exactly once, in the order they became visible.
    expect(emittedIds()).toEqual([B.id, A.id]);
    // After B was seen, the tail kept asking for hits from before A started.
    for (const since of feed.sinces.slice(1)) {
      expect(Date.parse(since)).toBeLessThan(Date.parse(A.occurred_at));
    }
  }, 20_000);
});
