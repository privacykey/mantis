import { afterEach, describe, expect, it } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// The Kandji fleet scripts run against a Mantis server whose enrollment
// contract is: an enroll key may only send memo, external_id, response_kind
// and a short dedupe window; 403/409/422 are refusals; a claim can return an
// existing key. These tests drive the real scripts with a stub `curl` and
// check that they send only permitted fields, fail visibly on a refusal, and
// never install or record a key that is disabled or has an expiry.

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const hasJq = spawnSync("jq", ["--version"]).status === 0;
const hasZsh = spawnSync("zsh", ["--version"]).status === 0;

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const DEL = String.fromCharCode(127);
const CSI_C1 = String.fromCharCode(0x9b);
// Any C0 control except LF, DEL, or a C1 control.
const CONTROL_RE = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(9)}` +
    `${String.fromCharCode(11)}-${String.fromCharCode(31)}` +
    `${DEL}-${String.fromCharCode(0x9f)}]`,
);

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

type Reply = { code: number | string; body?: unknown };

function stubDir(replies: Record<string, Reply>): string {
  const dir = mkdtempSync(join(tmpdir(), "mantis-kandji-"));
  tempDirs.push(dir);
  mkdirSync(join(dir, "bin"));
  mkdirSync(join(dir, "responses"));
  for (const [serial, reply] of Object.entries(replies)) {
    writeFileSync(join(dir, "responses", `${serial}.code`), String(reply.code));
    writeFileSync(
      join(dir, "responses", `${serial}.json`),
      typeof reply.body === "string"
        ? reply.body
        : JSON.stringify(reply.body ?? {}),
    );
  }
  // Test double for curl: Kandji inventory GETs return kandji.json; Mantis
  // POSTs are recorded and answered from responses/<external_id>.{json,code}.
  // A serial with no canned reply behaves like a network failure (code 000).
  writeFileSync(
    join(dir, "bin/curl"),
    `#!/bin/sh
body=""; url=""
while [ $# -gt 0 ]; do
  case "$1" in
    -d) body="$2"; shift 2 ;;
    -w|-H|-X|-m) shift 2 ;;
    -*) shift ;;
    *) url="$1"; shift ;;
  esac
done
case "$url" in
  */api/v1/devices*) cat "$STUB_DIR/kandji.json"; exit 0 ;;
esac
printf '%s' "$body" | jq -c . >> "$STUB_DIR/requests.jsonl" || echo '"UNPARSEABLE"' >> "$STUB_DIR/requests.jsonl"
id=$(printf '%s' "$body" | jq -r '.external_id')
code=$(cat "$STUB_DIR/responses/$id.code" 2>/dev/null || echo 000)
cat "$STUB_DIR/responses/$id.json" 2>/dev/null
printf '\\n%s' "$code"
`,
  );
  chmodSync(join(dir, "bin/curl"), 0o755);
  return dir;
}

function requests(dir: string): Array<Record<string, unknown>> {
  const file = join(dir, "requests.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function liveKey(serial: string, extra: Record<string, unknown> = {}) {
  return {
    id: `id-${serial}`,
    public_id: `pub${serial}`,
    url: `https://mantis.example.com/c/pub${serial}`,
    kind: "canary",
    memo: `Terminal opened (${serial})`,
    external_id: serial,
    created_at: "2026-01-01T00:00:00.000Z",
    disabled: false,
    expires_at: null,
    ...extra,
  };
}

const ENROLL_FIELDS = [
  "dedupe_window_seconds",
  "external_id",
  "memo",
  "response_kind",
];

// Each case runs a shell script that forks a dozen or so short-lived processes;
// allow for a loaded CI runner.
const SCRIPT_TIMEOUT = { timeout: 120_000 };

describe.skipIf(!hasJq)("deploy/kandji/preprovision.sh", SCRIPT_TIMEOUT, () => {
  function run(
    devices: Array<{ serial_number?: string; device_name?: string }>,
    replies: Record<string, Reply>,
    env: Record<string, string> = {},
  ) {
    const dir = stubDir(replies);
    writeFileSync(join(dir, "kandji.json"), JSON.stringify(devices));
    const csvPath = join(dir, "out.csv");
    const result = spawnSync(
      "bash",
      [join(PROJECT_ROOT, "deploy/kandji/preprovision.sh")],
      {
        cwd: dir,
        encoding: "utf8",
        env: {
          NODE_ENV: "test",
          PATH: `${join(dir, "bin")}:${process.env.PATH}`,
          STUB_DIR: dir,
          KANDJI_API_URL: "https://kandji.example",
          KANDJI_API_TOKEN: "kandji-test-token",
          MANTIS_BASE_URL: "https://mantis.example.com",
          MANTIS_API_KEY: "mantis_test_full_key",
          OUT_CSV: csvPath,
          ...env,
        },
      },
    );
    return {
      dir,
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      csv: existsSync(csvPath) ? readFileSync(csvPath, "utf8") : "",
    };
  }

  it("neutralises formula prefixes and strips control characters from device names", () => {
    const hostile = `Lab${ESC}[2K${ESC}[1GMac${BEL}${CSI_C1}${DEL}`;
    const r = run(
      [
        { serial_number: "C02AAA", device_name: '=HYPERLINK("https://evil.example","open")' },
        { serial_number: "C02BBB", device_name: hostile },
        { serial_number: "C02CCC", device_name: "+1+1" },
        { serial_number: "C02DDD", device_name: "-2+3" },
        { serial_number: "C02EEE", device_name: "@SUM(1,1)" },
        { serial_number: "C02FFF", device_name: "Zoe's MacBook" },
      ],
      {
        C02AAA: { code: 201, body: liveKey("C02AAA") },
        C02BBB: { code: 201, body: liveKey("C02BBB") },
        C02CCC: { code: 201, body: liveKey("C02CCC") },
        C02DDD: { code: 201, body: liveKey("C02DDD") },
        C02EEE: { code: 201, body: liveKey("C02EEE") },
        C02FFF: {
          code: 200,
          body: liveKey("C02FFF", { reused: true, created_by_caller: true }),
        },
      },
    );

    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    const rows = r.csv.trim().split("\n");
    expect(rows[0]).toBe("serial,device_name,key_id,trigger_url,reused");
    expect(rows[1]).toContain(`"C02AAA","'=HYPERLINK(""https://evil.example"",""open"")"`);
    expect(rows[2]).toContain('"C02BBB","Lab[2K[1GMac"');
    expect(rows[3]).toContain(`"C02CCC","'+1+1"`);
    expect(rows[4]).toContain(`"C02DDD","'-2+3"`);
    expect(rows[5]).toContain(`"C02EEE","'@SUM(1,1)"`);
    expect(rows[6]).toBe(
      '"C02FFF","Zoe\'s MacBook","id-C02FFF","https://mantis.example.com/c/pubC02FFF","true"',
    );
    for (const text of [r.csv, r.stdout, r.stderr]) {
      expect(CONTROL_RE.test(text)).toBe(false);
    }
    // The memo sent to the server carries the cleaned name too.
    const memos = requests(r.dir).map((b) => String(b.memo));
    expect(memos[1]).toBe("Terminal opened — Lab[2K[1GMac (C02BBB)");
    for (const body of requests(r.dir)) {
      expect(Object.keys(body).sort()).toEqual(ENROLL_FIELDS);
      expect(body.response_kind).toBe("empty");
    }
  });

  it("exits non-zero with a clear message on 403, 409 and 422, and keeps going", () => {
    const r = run(
      [
        { serial_number: "C02F403", device_name: "forbidden" },
        { serial_number: "C02F409", device_name: `rename${ESC}[2K${ESC}[1Gme` },
        { serial_number: "C02F422", device_name: "invalid" },
        { serial_number: "C02OK", device_name: "fine" },
      ],
      {
        C02F403: { code: 403, body: { error: "forbidden", message: `no${ESC}[31m` } },
        C02F409: { code: 409, body: { error: "conflict" } },
        C02F422: { code: 422, body: { error: "validation_error" } },
        C02OK: { code: 201, body: liveKey("C02OK") },
      },
    );

    expect(r.status).toBe(1);
    expect(r.stderr).toContain("FAILED C02F403 (forbidden): HTTP 403");
    expect(r.stderr).toContain("MANTIS_ENROLL_DESTINATIONS");
    expect(r.stderr).toContain("FAILED C02F409 (rename[2K[1Gme): HTTP 409");
    expect(r.stderr).toContain("disabled or expired");
    expect(r.stderr).toContain("FAILED C02F422 (invalid): HTTP 422");
    expect(r.stderr).toContain("3 device(s) were NOT provisioned");
    expect(CONTROL_RE.test(r.stderr)).toBe(false);
    const rows = r.csv.trim().split("\n");
    expect(rows).toHaveLength(2);
    expect(rows[1]).toContain('"C02OK"');
  });

  it("refuses to record a key that is disabled, expiring, or not described as live", () => {
    const r = run(
      [
        { serial_number: "C02DIS", device_name: "disabled" },
        { serial_number: "C02EXP", device_name: "expiring" },
        { serial_number: "C02OLD", device_name: "fieldless" },
        { serial_number: "C02TXT", device_name: "not json" },
      ],
      {
        C02DIS: { code: 200, body: liveKey("C02DIS", { reused: true, disabled: true }) },
        C02EXP: {
          code: 200,
          body: liveKey("C02EXP", { reused: true, expires_at: "2000-01-01T00:00:00.000Z" }),
        },
        C02OLD: { code: 200, body: { id: "x", url: "https://mantis.example.com/c/x", reused: true } },
        C02TXT: { code: 200, body: "<html>proxy error</html>" },
      },
    );

    expect(r.status).toBe(1);
    expect(r.stderr).toContain("FAILED C02DIS (disabled): the server returned a DISABLED key");
    expect(r.stderr).toContain("FAILED C02EXP (expiring): the server returned a key with an expiry");
    expect(r.stderr).toContain("FAILED C02OLD (fieldless): the response did not describe a live key");
    expect(r.stderr).toContain("FAILED C02TXT (not json): the response did not describe a live key");
    expect(r.csv.trim().split("\n")).toHaveLength(1); // header only
  });

  it("does not report NOTIFY_* as attached when another API key created the key", () => {
    const devices = [{ serial_number: "C02FOR", device_name: "self-enrolled" }];
    const replies = {
      C02FOR: {
        code: 200,
        body: liveKey("C02FOR", { reused: true, created_by_caller: false }),
      },
    };

    const withNotify = run(devices, replies, {
      NOTIFY_CHANNEL: "slack",
      NOTIFY_TARGET: "https://hooks.slack.com/services/T000/B000/XXXX",
    });
    expect(withNotify.status).toBe(1);
    expect(withNotify.stderr).toContain("was NOT attached");
    expect(withNotify.csv.trim().split("\n")).toHaveLength(1);
    expect(requests(withNotify.dir)[0]!.destinations).toEqual([
      { channel: "slack", target: "https://hooks.slack.com/services/T000/B000/XXXX" },
    ]);

    const withoutNotify = run(devices, replies);
    expect(withoutNotify.status).toBe(0);
    expect(withoutNotify.stderr).toContain("WARNING C02FOR (self-enrolled)");
    expect(withoutNotify.csv.trim().split("\n")).toHaveLength(2);
  });

  it("aborts at once when the API key itself is rejected", () => {
    const r = run(
      [
        { serial_number: "C02ONE", device_name: "one" },
        { serial_number: "C02TWO", device_name: "two" },
      ],
      { C02ONE: { code: 401, body: { error: "unauthorized" } } },
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("MANTIS_API_KEY was rejected (HTTP 401)");
    expect(requests(r.dir)).toHaveLength(1);
  });

  it("skips a serial the server would reject as an external_id", () => {
    const r = run(
      [
        { serial_number: "bad serial!", device_name: "odd" },
        { serial_number: "C02OK2", device_name: "fine" },
      ],
      { C02OK2: { code: 201, body: liveKey("C02OK2") } },
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("serial is not a valid external_id");
    expect(requests(r.dir)).toHaveLength(1);
  });
});

describe.skipIf(!hasJq || !hasZsh)("deploy/kandji/mantis-terminal-canary.zsh", SCRIPT_TIMEOUT, () => {
  const SERIAL = "C02TESTSERIAL";
  const URL_OLD = "https://mantis.example.com/c/oldinstalled";

  // The script is written for root on a managed Mac. Run a copy with the root
  // check removed and its two system paths pointed into a scratch directory;
  // everything else (request building, response handling, install) is the
  // shipped code. `ioreg`, `scutil`, `install` and `chown` are stubbed.
  function run(
    reply: Reply | null,
    opts: {
      configure?: Record<string, string>;
      installedUrl?: string;
      verified?: boolean;
      computerName?: string;
    } = {},
  ) {
    const dir = stubDir(reply ? { [SERIAL]: reply } : {});
    const state = join(dir, "state");
    const zprofile = join(dir, "zprofile");

    let script = readFileSync(
      join(PROJECT_ROOT, "deploy/kandji/mantis-terminal-canary.zsh"),
      "utf8",
    );
    const replace = (from: string | RegExp, to: string) => {
      const next = script.replace(from, to);
      if (next === script) throw new Error(`test harness: pattern not found: ${from}`);
      script = next;
    };
    replace(/if \[\[ \$EUID -ne 0 \]\]; then\n.*\n.*\nfi\n/, "");
    replace('STATE_DIR="/Library/Application Support/Mantis"', `STATE_DIR="${state}"`);
    replace('ZPROFILE="/etc/zprofile"', `ZPROFILE="${zprofile}"`);
    replace('MANTIS_ENROLL_KEY="mantis_live_REPLACE_ME"', 'MANTIS_ENROLL_KEY="mantis_test_enroll_key"');
    for (const [name, value] of Object.entries(opts.configure ?? {})) {
      replace(new RegExp(`^${name}=.*$`, "m"), `${name}=${value}`);
    }
    writeFileSync(join(dir, "canary.zsh"), script);

    const stub = (name: string, body: string) => {
      writeFileSync(join(dir, "bin", name), `#!/bin/sh\n${body}\n`);
      chmodSync(join(dir, "bin", name), 0o755);
    };
    stub("ioreg", `echo '    "IOPlatformSerialNumber" = "${SERIAL}"'`);
    stub("scutil", 'cat "$STUB_DIR/computer-name"');
    stub("install", 'for last; do :; done; mkdir -p "$last"');
    stub("chown", "exit 0");
    writeFileSync(join(dir, "computer-name"), `${opts.computerName ?? "Test Mac"}\n`);

    if (opts.installedUrl) {
      mkdirSync(state, { recursive: true });
      writeFileSync(join(state, "trigger-url"), `${opts.installedUrl}\n`);
      if (opts.verified) writeFileSync(join(state, "enroll-verified"), "verified\n");
    }

    const result = spawnSync("zsh", [join(dir, "canary.zsh")], {
      cwd: dir,
      encoding: "utf8",
      env: {
        NODE_ENV: "test",
        PATH: `${join(dir, "bin")}:${process.env.PATH}`,
        STUB_DIR: dir,
      },
    });
    const read = (name: string) =>
      existsSync(join(state, name)) ? readFileSync(join(state, name), "utf8") : null;
    return {
      dir,
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      url: read("trigger-url"),
      verified: read("enroll-verified") !== null,
      snippet: read("terminal-canary.sh"),
      zprofile: existsSync(zprofile) ? readFileSync(zprofile, "utf8") : null,
    };
  }

  it("enrolls with only the fields an enroll key may send, and installs a live key", () => {
    const r = run(
      { code: 201, body: liveKey(SERIAL) },
      { computerName: `Dev "Lab" \\ Mac${ESC}[2K` },
    );

    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.url).toBe(`https://mantis.example.com/c/pub${SERIAL}\n`);
    expect(r.verified).toBe(true);
    expect(r.snippet).toContain("X-Mantis-Source: kandji-terminal");
    expect(r.zprofile).toContain("BEGIN MANTIS TERMINAL CANARY");

    const sent = requests(r.dir);
    expect(sent).toHaveLength(1);
    expect(Object.keys(sent[0]!).sort()).toEqual(ENROLL_FIELDS);
    expect(sent[0]).toMatchObject({
      memo: `Terminal opened — Dev "Lab" \\ Mac[2K (${SERIAL})`,
      external_id: SERIAL,
      response_kind: "empty",
      dedupe_window_seconds: 120,
    });
  });

  it.each([
    ["an expired key", liveKey(SERIAL, { reused: true, expires_at: "2000-01-01T00:00:00.000Z" })],
    ["a future-expiring key", liveKey(SERIAL, { reused: true, expires_at: "2099-01-01T00:00:00.000Z" })],
    ["a disabled key", liveKey(SERIAL, { reused: true, disabled: true })],
    [
      "a dead key whose memo imitates the live markers",
      liveKey(SERIAL, {
        reused: true,
        disabled: true,
        expires_at: "2000-01-01T00:00:00.000Z",
        memo: 'x","disabled":false,"expires_at":null,"y":"',
      }),
    ],
    ["a response that does not state liveness", { id: "x", url: "https://mantis.example.com/c/x" }],
  ])("refuses to install %s", (_label, body) => {
    const r = run({ code: 200, body });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("refusing to install it");
    expect(r.url).toBeNull();
    expect(r.verified).toBe(false);
    expect(r.zprofile).toBeNull();
  });

  it.each([
    [403, "enrollment refused (HTTP 403)"],
    [409, "enrollment refused (HTTP 409)"],
    [422, "enrollment rejected as invalid (HTTP 422)"],
    [401, "enrollment failed (HTTP 401)"],
  ])("exits 2 with a clear message on HTTP %i", (code, message) => {
    const r = run({ code, body: { error: "nope" } });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain(message);
    expect(r.url).toBeNull();
    expect(r.zprofile).toBeNull();
  });

  it("sends a destination only when configured, and explains a 403 for it", () => {
    const r = run(
      { code: 403, body: { error: "forbidden" } },
      {
        configure: {
          MANTIS_NOTIFY_CHANNEL: '"slack"',
          MANTIS_NOTIFY_TARGET: '"https://hooks.slack.com/services/T000/B000/XXXX"',
        },
      },
    );
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("MANTIS_ENROLL_DESTINATIONS");
    const sent = requests(r.dir);
    expect(Object.keys(sent[0]!).sort()).toEqual([...ENROLL_FIELDS, "destinations"].sort());
    expect(sent[0]!.destinations).toEqual([
      { channel: "slack", target: "https://hooks.slack.com/services/T000/B000/XXXX" },
    ]);
  });

  it("rejects a dedupe window the server would refuse, before any request", () => {
    const r = run(
      { code: 201, body: liveKey(SERIAL) },
      { configure: { MANTIS_DEDUPE_SECONDS: "900" } },
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("MANTIS_DEDUPE_SECONDS");
    expect(requests(r.dir)).toHaveLength(0);
  });

  it("does not contact the server again once the install is verified", () => {
    const r = run(null, { installedUrl: URL_OLD, verified: true });
    expect(r.status).toBe(0);
    expect(requests(r.dir)).toHaveLength(0);
    expect(r.url).toBe(`${URL_OLD}\n`);
  });

  it("re-checks an install made before liveness was verified", () => {
    const live = run({ code: 200, body: liveKey(SERIAL, { reused: true }) }, { installedUrl: URL_OLD });
    expect(live.status).toBe(0);
    expect(live.stdout).toContain(`re-verified ${SERIAL}`);
    expect(live.verified).toBe(true);
    expect(live.url).toBe(`https://mantis.example.com/c/pub${SERIAL}\n`);

    const dead = run({ code: 409, body: { error: "conflict" } }, { installedUrl: URL_OLD });
    expect(dead.status).toBe(2);
    expect(dead.stderr).toContain("enrollment refused (HTTP 409)");
    expect(dead.verified).toBe(false);

    const expired = run(
      { code: 200, body: liveKey(SERIAL, { reused: true, expires_at: "2000-01-01T00:00:00.000Z" }) },
      { installedUrl: URL_OLD },
    );
    expect(expired.status).toBe(2);
    expect(expired.verified).toBe(false);
  });

  it("keeps the installed tripwire when the re-check cannot reach the server", () => {
    for (const reply of [null, { code: 503, body: { error: "unavailable" } }]) {
      const r = run(reply, { installedUrl: URL_OLD });
      expect(r.status).toBe(0);
      expect(r.stderr).toContain("could not re-verify enrollment");
      expect(r.url).toBe(`${URL_OLD}\n`);
      expect(r.verified).toBe(false);
      expect(r.zprofile).toContain("BEGIN MANTIS TERMINAL CANARY");
    }
  });
});
