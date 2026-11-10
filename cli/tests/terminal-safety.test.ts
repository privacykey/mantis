import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  // Every command below passes --base-url/--key; make sure a real CLI config
  // on the machine running the tests is never consulted.
  process.env.XDG_CONFIG_HOME = "/nonexistent/mantis-cli-tests";
});

import { deepDetector } from "../src/commands/detect/detectors/deep.js";
import { renderHuman } from "../src/commands/detect/render.js";
import {
  addDestinationCmd,
  listDestinationsCmd,
  rotateDestinationSecretCmd,
  testDestinationCmd,
} from "../src/commands/destinations.js";
import { hitsCmd } from "../src/commands/hits.js";
import { lastCmd } from "../src/commands/last.js";
import { listCmd } from "../src/commands/list.js";
import { showCmd } from "../src/commands/show.js";
import { watchCmd } from "../src/commands/watch.js";
import { setRedactWebhooks } from "../src/lib/destination-format.js";
import {
  jsonText,
  safeBlock,
  safeText,
  setColorMode,
  setJsonMode,
  table,
  truncate,
} from "../src/lib/out.js";

const ch = String.fromCharCode;
const ESC = ch(0x1b);
const BEL = ch(0x07);
const CSI = ch(0x9b); // C1 "control sequence introducer": ESC [ in one code point
const RLO = ch(0x202e); // right-to-left override

// Everything a terminal acts on, other than the newline that ends our own
// lines: C0, DEL, C1, line/paragraph separators, bidi controls.
const RAW_CONTROL = new RegExp(
  `[${ch(0)}-${ch(0x09)}${ch(0x0b)}-${ch(0x1f)}${ch(0x7f)}-${ch(0x9f)}${ch(0x2028)}${ch(0x2029)}${ch(0x202a)}-${ch(0x202e)}${ch(0x2066)}-${ch(0x2069)}]`,
);

// Cursor up, erase line, carriage return: rewrites the line printed before it.
const MEMO = `prod db${ESC}[1A${ESC}[2K\rall clear`;
// OSC 0 sets the window title.
const TARGET = `https://attacker.example/hook${ESC}]0;spoofed-title${BEL}`;
const USER_AGENT = `curl/8.0${CSI}2K${RLO}`;

const KEY_ID = "00000000-0000-4000-8000-00000000000a";
const auth = { baseUrl: "https://mantis.example.com", key: "fake", retries: "0" };

const key = {
  id: KEY_ID,
  public_id: "pubAAAA1",
  url: "https://mantis.example.com/c/pubAAAA1",
  kind: "http",
  memo: MEMO,
  response_kind: "gif",
  response_payload: null,
  destinations: [
    {
      id: "d0000000-0000-4000-8000-000000000001",
      channel: "webhook",
      target: TARGET,
      signing_secret: null,
      created_at: "2026-09-01T00:00:00.000Z",
      last_activation_status: "failed",
      last_activation_error: `boom${ESC}[2J`,
      last_activation_at: null,
    },
  ],
  dedupe_window_seconds: 0,
  monitor_mode: "off",
  monitor_window_seconds: 300,
  monitor_reset_at: null,
  monitor_status_url: null,
  created_at: "2026-09-01T00:00:00.000Z",
  disabled_at: null,
  expires_at: null,
  disabled: false,
};

function hit(id: string, occurredAt: string, memo = MEMO) {
  return {
    id,
    key: { id: KEY_ID, public_id: "pubAAAA1", memo },
    occurred_at: occurredAt,
    ip: `203.0.113.7${ESC}[5m`,
    user_agent: USER_AGENT,
    referer: `https://ref.example/${CSI}1A`,
    headers: { [`x-evil${ESC}[0m`]: `v${BEL}`, "user-agent": USER_AGENT },
    ua_browser: null,
    ua_browser_version: null,
    ua_os: null,
    ua_device: null,
    bot_label: `scanner${ESC}[8m`,
    is_duplicate: false,
    host_context: {
      source: `shell${ESC}c`,
      user: "root",
      host: `web-01${CSI}2J`,
      ssh_client: null,
      ssh_connection: null,
      ssh_client_ip: null,
      tty: null,
      sudo_cmd: `rm -rf /${ESC}[1A`,
      network_interface: null,
      event: `login${ESC}[2K`,
      device: `laptop${BEL}`,
      entity_id: null,
      automation: null,
      area: null,
      iot_mac: null,
      iot_ip: null,
    },
    notifications: [
      {
        id: "n1",
        channel: "webhook",
        target: TARGET,
        destination_scope: "key",
        status: "failed",
        attempts: 1,
        max_attempts: 5,
        next_attempt_at: "2026-09-01T00:00:00.000Z",
        succeeded_at: null,
        last_error: `HTTP 500${ESC}]52;c;AAAA${BEL}`,
      },
    ],
  };
}

let stdout: string[];
let stderr: string[];
let sigintBefore: NodeJS.SignalsListener[];

beforeEach(() => {
  stdout = [];
  stderr = [];
  vi.spyOn(process.stdout, "write").mockImplementation((x) => {
    stdout.push(String(x));
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((x) => {
    stderr.push(String(x));
    return true;
  });
  // With color off, no escape byte at all is legitimate.
  setColorMode("never");
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
  setColorMode("auto");
  setJsonMode(false);
  setRedactWebhooks(false);
  process.exitCode = undefined;
});

function expectInert(text: string): void {
  expect(text).not.toMatch(RAW_CONTROL);
}

/** Advance fake time (yielding to real I/O) until `done()` holds. */
async function until(done: () => boolean): Promise<void> {
  for (let i = 0; i < 400 && !done(); i++) {
    await vi.advanceTimersByTimeAsync(250);
  }
  expect(done()).toBe(true);
}

describe("safeText / safeBlock / jsonText", () => {
  it("turns C0, DEL, C1 and bidi controls into visible escapes", () => {
    const out = safeText(`a${ESC}[2Kb\r\n${BEL}${ch(0x7f)}${CSI}${RLO}${ch(0x2028)}z`);
    expectInert(out);
    expect(out).toBe(
      "a\\u001b[2Kb\\u000d\\u000a\\u0007\\u007f\\u009b\\u202e\\u2028z",
    );
  });

  it("leaves ordinary text, including non-ASCII, alone", () => {
    expect(safeText("déjà vu — 日本語 ✓")).toBe("déjà vu — 日本語 ✓");
    expect(safeText(null)).toBe("");
    expect(safeText(undefined)).toBe("");
    expect(safeText(42)).toBe("42");
  });

  it("safeBlock keeps tabs and LF / CRLF line ends but not a bare CR", () => {
    expect(safeBlock(`a\tb\nc\r\nd\re${ESC}[0m`)).toBe(
      "a\tb\nc\r\nd\\u000de\\u001b[0m",
    );
  });

  it("jsonText escapes C1 and bidi controls and still round-trips", () => {
    const value = { ua: USER_AGENT, memo: MEMO, sep: ch(0x2028) };
    const text = jsonText(value);
    expectInert(text);
    expect(JSON.parse(text)).toEqual(value);
  });
});

describe("truncate / table never pass control bytes through", () => {
  it("escapes foreign control bytes whether or not the text is cut", () => {
    expectInert(truncate(`ab${ESC}]0;x${BEL}`, 80));
    expectInert(truncate(`ab${ESC}]0;x${BEL}${"z".repeat(50)}`, 10));
    // A cursor-movement CSI is not one of our color codes.
    expectInert(truncate(`${ESC}[1A${ESC}[2Kgone`, 80));
  });

  it("still preserves the color codes the CLI emits", () => {
    expect(truncate(`${ESC}[31mhello${ESC}[0m`, 80)).toBe(`${ESC}[31mhello${ESC}[0m`);
  });

  it("neutralizes a raw cell that reached table() unescaped", () => {
    const out = table(["memo"], [[`x${ESC}[1A\ry`]]);
    expect(out).toContain("x\\u001b[1A\\u000dy");
  });
});

describe("hostile API strings stay inert in human output", () => {
  it("watch: a later hit cannot rewrite the line printed before it", async () => {
    vi.useFakeTimers();
    let polls = 0;
    vi.stubGlobal("fetch", async (url: URL) => {
      if (url.searchParams.get("anchor") === "1") {
        return Response.json({
          data: [],
          next_cursor: null,
          server_time: "2026-09-01T10:00:00.000Z",
        });
      }
      polls += 1;
      return Response.json({
        // Newest first: the attacker's hit is printed after the genuine one.
        data: [
          hit("h-attacker", "2026-09-01T10:00:02.000Z"),
          hit("h-genuine", "2026-09-01T10:00:01.000Z", "prod database"),
        ],
        next_cursor: null,
      });
    });

    const run = watchCmd({ ...auth, interval: "1" });
    await until(() => polls >= 1 && stdout.length >= 2);
    process.emit("SIGINT");
    await run;

    const out = stdout.join("");
    expect(out.split("\n").filter(Boolean)).toHaveLength(2);
    expectInert(out.replace(/\n/g, ""));
    expect(out).toContain("prod database");
    expect(out).toContain("prod db\\u001b[1A\\u001b[2K\\u000dall clear");
    // A host event is drawn as who@host and what ran, both attacker-chosen.
    expect(out).toContain("root@web-01\\u009b2J");
    expect(out).toContain("rm -rf /\\u001b[1A");
  }, 20_000);

  it("watch --json: the NDJSON stream carries no raw C1 and still parses", async () => {
    vi.useFakeTimers();
    setJsonMode(true);
    vi.stubGlobal("fetch", async (url: URL) =>
      url.searchParams.get("anchor") === "1"
        ? Response.json({ data: [], next_cursor: null, server_time: "2026-09-01T10:00:00.000Z" })
        : Response.json({ data: [hit("h1", "2026-09-01T10:00:01.000Z")], next_cursor: null }),
    );

    const run = watchCmd({ ...auth, interval: "1" });
    await until(() => stdout.length >= 1);
    process.emit("SIGINT");
    await run;

    const line = stdout.join("").trimEnd();
    expectInert(line);
    expect(JSON.parse(line).user_agent).toBe(USER_AGENT);
    expect(JSON.parse(line).key.memo).toBe(MEMO);
  }, 20_000);

  it.each([
    ["table", false],
    ["verbose", true],
  ])("hits (%s): targets, headers, host context and errors are escaped", async (_name, verbose) => {
    vi.stubGlobal("fetch", async () =>
      Response.json({ data: [hit("h1", "2026-09-01T10:00:01.000Z")], next_cursor: null }),
    );
    await hitsCmd(KEY_ID, { ...auth, verbose });
    const out = stdout.join("");
    expectInert(out.replace(/\n/g, ""));
    if (verbose) {
      expect(out).toContain("https://attacker.example/hook\\u001b]0;spoofed-title\\u0007");
      expect(out).toContain("HTTP 500\\u001b]52;c;AAAA\\u0007");
      expect(out).toContain("x-evil\\u001b[0m:");
      expect(out).toContain("rm -rf /\\u001b[1A");
    } else {
      // The bot tag takes the tag column, so the table shows the host, not the source.
      expect(out).toContain("root@web-01\\u009b2J");
    }
  });

  it("hits keeps the recorded IP and identifies a distinct reported SSH client", async () => {
    const base = hit("h1", "2026-09-01T10:00:01.000Z");
    const fixture = { ...base, host_context: { ...base.host_context, ssh_client_ip: "192.0.2.15" } };
    vi.stubGlobal("fetch", async () => Response.json({ data: [fixture], next_cursor: null }));
    await hitsCmd(KEY_ID, auth);
    const out = stdout.join("");
    expect(out).toMatch(/203\.0\.113\.7\\u001b\[5m\s+root@/);
    expect(out).toContain("192.0.2.15");
    expect(stderr.join("")).toContain("reported SSH client address");
  });

  it("verbose hits retain headers without a matching rendered field", async () => {
    const fixture = hit("h1", "2026-09-01T10:00:01.000Z");
    const headers: Record<string, string> = {
      ...fixture.headers,
      "x-mantis-source": fixture.host_context.source,
      "x-mantis-page-url": "https://clone.example/",
      "x-mantis-page-referrer": "https://ref.example/",
      "x-mantis-request-path": "/bucket/object",
      "x-mantis-ssh-client": "192.0.2.15 54321 22",
    };
    vi.stubGlobal("fetch", async () => Response.json({ data: [{ ...fixture, headers }], next_cursor: null }));
    await hitsCmd(KEY_ID, { ...auth, verbose: true });
    const out = stdout.join("");
    expect(out).not.toContain("x-mantis-source:");
    for (const name of ["x-mantis-page-url", "x-mantis-page-referrer", "x-mantis-request-path", "x-mantis-ssh-client"]) {
      expect(out).toContain(`${name}: ${headers[name]}`);
    }
  });

  it.each([
    ["table", "table"],
    ["wide", "wide"],
  ] as const)("list (%s): the memo column is escaped", async (_name, output) => {
    const { setOutputMode } = await import("../src/lib/out.js");
    setOutputMode(output);
    vi.stubGlobal("fetch", async () => Response.json({ data: [key], next_cursor: null }));
    try {
      await listCmd(auth);
    } finally {
      setOutputMode("table");
    }
    const out = stdout.join("");
    expectInert(out.replace(/\n/g, ""));
    expect(out).toContain("prod db\\u001b[1A");
  });

  it("show: memo, destination target and activation error are escaped", async () => {
    vi.stubGlobal("fetch", async () => Response.json(key));
    await showCmd(KEY_ID, auth);
    const out = stdout.join("");
    expectInert(out.replace(/\n/g, ""));
    expect(out).toContain("prod db\\u001b[1A\\u001b[2K\\u000dall clear");
    expect(out).toContain("spoofed-title\\u0007");
    expect(out).toContain("boom\\u001b[2J");
  });

  it("last: the memo echoed to stderr is escaped", async () => {
    vi.stubGlobal("fetch", async () => Response.json({ data: [key], next_cursor: null }));
    await lastCmd(auth);
    expect(stdout.join("")).toBe(`${KEY_ID}\n`);
    const err = stderr.join("");
    expectInert(err.replace(/\n/g, ""));
    expect(err).toContain("prod db\\u001b[1A");
  });

  it("dest test: the preview is escaped and says the test hit is a real one", async () => {
    vi.stubGlobal("fetch", async () => Response.json(key));
    await testDestinationCmd(KEY_ID, auth);
    const err = stderr.join("");
    expectInert(err.replace(/\n/g, ""));
    expect(err).toContain("REAL hit");
    expect(err).toContain("dedupe window");
    expect(err).toMatch(/monitor/);
  });

  it("API error text is escaped before it reaches the terminal", async () => {
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
    vi.stubGlobal("fetch", async () =>
      Response.json({ error: "validation_error", message: `bad memo${ESC}[2K\nerror: forged` }, { status: 422 }),
    );
    await expect(showCmd(KEY_ID, auth)).rejects.toThrow("exit");
    const err = stderr.join("");
    expectInert(err.replace(/\n/g, ""));
    // One line: the newline inside the server's message did not start another.
    expect(err.trimEnd().split("\n")).toHaveLength(1);
  });

  it.each([
    ["deadbeef", 5, "no key matches prefix 'deadbeef'. Run `mantis list` to see configured keys."],
    [KEY_ID, 6, "fetch failed. Check `mantis whoami`, pass --base-url, or verify the server is reachable"],
  ] as const)("preserves JSON error text for %s", async (id, code, error) => {
    setJsonMode(true);
    vi.spyOn(process, "exit").mockImplementation(() => { throw new Error("exited"); });
    vi.stubGlobal("fetch", async () => {
      if (id === KEY_ID) throw new Error("fetch failed");
      return Response.json({ data: [], next_cursor: null });
    });
    await expect(showCmd(id, auth)).rejects.toThrow("exited");
    expect(process.exit).toHaveBeenCalledWith(code);
    expect(JSON.parse(stderr.join(""))).toEqual({ error });
  });
});

describe("opt-in webhook redaction", () => {
  const credential = "fixture-only";
  const webhook = {
    ...key.destinations[0]!,
    target: `https://hook.example/${credential}?token=${credential}`,
    last_activation_error: `HTTP 403 rejected ${credential}`,
  };
  const email = { ...webhook, id: "other", channel: "email", target: "ops@example.com" };
  const fixture = { ...key, destinations: [webhook, email] };

  it("redacts text output when enabled and preserves the full target in JSON", async () => {
    vi.stubGlobal("fetch", async () => Response.json(fixture));
    await listDestinationsCmd(KEY_ID, auth);
    expect(stdout.join("")).toContain(webhook.target);

    stdout = [];
    setRedactWebhooks(true);
    await listDestinationsCmd(KEY_ID, auth);
    const rendered = stdout.join("");
    expect(rendered).toContain("https://hook.example/");
    expect(rendered).toContain(email.target);
    expect(rendered).not.toContain(credential);

    stdout = [];
    setJsonMode(true);
    await listDestinationsCmd(KEY_ID, auth);
    expect(JSON.parse(stdout.join("")).data[0].target).toBe(webhook.target);
  });

  it("redacts add confirmation and test and rotation previews", async () => {
    setRedactWebhooks(true);
    vi.stubGlobal("fetch", async (_url: URL, init: RequestInit) =>
      Response.json(init.method === "PATCH" ? { ...key, destinations: [webhook] } : fixture),
    );
    await addDestinationCmd(KEY_ID, "webhook", webhook.target, auth);
    await testDestinationCmd(KEY_ID, auth);
    await rotateDestinationSecretCmd(KEY_ID, webhook.id, auth);

    expect(stdout.join("")).toContain("HTTP 403 (details hidden)");
    expect(stdout.join("")).not.toContain(credential);
    const previews = stderr.join("");
    expect(previews).toContain("https://hook.example/");
    expect(previews).toContain(email.target);
    expect(previews).not.toContain(credential);
  });

  it("hides credentials echoed in activation and delivery errors", async () => {
    setRedactWebhooks(true);
    vi.stubGlobal("fetch", async () => Response.json({ ...key, destinations: [webhook] }));
    await showCmd(KEY_ID, auth);
    const shown = stdout.join("");
    expect(shown).toContain("activation failed");
    expect(shown).toContain("HTTP 403 (details hidden)");
    expect(shown).not.toContain(credential);

    stdout = [];
    const base = hit("h1", "2026-09-01T10:00:01.000Z");
    const notification = { ...base.notifications[0]!, target: null, last_error: `provider refused ${credential}` };
    vi.stubGlobal("fetch", async () =>
      Response.json({ data: [{ ...base, notifications: [notification] }], next_cursor: null }),
    );
    await hitsCmd(KEY_ID, { ...auth, verbose: true });
    expect(stdout.join("")).toContain("details hidden by redact-webhooks");
    expect(stdout.join("")).not.toContain(credential);
  });
});

describe("hostile file names stay inert in `detect --deep` output", () => {
  let home: string | undefined;
  afterEach(() => {
    if (home) rmSync(home, { recursive: true, force: true });
    home = undefined;
  });

  it("a file name with ESC and a newline cannot forge a remove: line", async () => {
    home = mkdtempSync(join(tmpdir(), "mantis-detect-hostile-"));
    const name = `notes${ESC}[2K\nremove:   rm -rf ~ #.md`;
    writeFileSync(join(home, name), "see https://canarytokens.com/a/b/c.php\n");

    const r = await deepDetector.run({
      scope: "user",
      homeDir: home,
      platform: "linux",
      deep: true,
    });
    expect(r.findings).toHaveLength(1);

    const out = renderHuman(
      { scope: "user", scanned: ["deep"], permissionDenied: [], errors: [], findings: r.findings },
      { verbose: true },
    );
    expectInert(out.replace(/\n/g, ""));
    expect(out.split("\n").filter((l) => l.trimStart().startsWith("remove:"))).toHaveLength(1);
    expect(out).toContain("notes\\u001b[2K\\u000aremove:");
  });
});
