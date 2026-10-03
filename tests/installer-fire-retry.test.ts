import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildInstaller, type InstallType } from "@mantis/core/installers";

// Boot and wake alarms fire once per event, usually before the network is
// back. Their fire command must retry — a bounded number of times, with
// backoff — and must stop at the first success. These tests run the generated
// shell with a stand-in curl and sleep, so the schedule is observed rather
// than read off the template.

const input = {
  url: "https://mantis.example.com/c/AbCdEf2345",
  keyId: "3f7c1a2b-4d5e-6f70-8192-a3b4c5d6e7f8",
  memo: "web01 — boot",
};

const unescapeXml = (s: string) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");

/** The `sh -c` payload of a launchd plist or a systemd unit. */
function shPayload(type: InstallType): string {
  const { content } = buildInstaller(type, input);
  const m = type.startsWith("macos")
    ? /<string>-c<\/string>\s*<string>([^<]*)<\/string>/.exec(content)
    : /^ExecStart=\/bin\/sh -c '(.*)'$/m.exec(content);
  expect(m, `no sh -c payload in ${type}`).toBeTruthy();
  return type.startsWith("macos") ? unescapeXml(m![1]!) : m![1]!;
}

const posix = process.platform !== "win32";

// These spawn a shell per case; allow for a loaded machine.
describe.skipIf(!posix)("one-shot boot/wake alarms retry with backoff", { timeout: 60_000 }, () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mantis-retry-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Stand-ins: a curl that fails `failures` times, and a sleep that only logs. */
  function stub(failures: number): void {
    writeFileSync(
      join(dir, "curl"),
      [
        "#!/bin/sh",
        `n=$(cat "${dir}/calls" 2>/dev/null || echo 0)`,
        "n=$((n+1))",
        `echo "$n" > "${dir}/calls"`,
        `printf '%s\\n' "$*" >> "${dir}/args"`,
        `[ "$n" -gt ${failures} ]`,
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    writeFileSync(
      join(dir, "sleep"),
      `#!/bin/sh\nprintf '%s\\n' "$1" >> "${dir}/sleeps"\n`,
      { mode: 0o755 },
    );
    writeFileSync(join(dir, "hostname"), "#!/bin/sh\necho testhost\n", {
      mode: 0o755,
    });
  }

  const read = (name: string) =>
    existsSync(join(dir, name))
      ? readFileSync(join(dir, name), "utf8").trim().split("\n")
      : [];
  const calls = () => Number(read("calls")[0] ?? 0);

  function run(script: string) {
    return spawnSync("/bin/sh", ["-c", script.replaceAll("/usr/bin/curl", join(dir, "curl"))], {
      // A minimal environment (NODE_ENV only because the env type requires it).
      env: { NODE_ENV: "test", PATH: `${dir}:/usr/bin:/bin`, USER: "alice" },
      encoding: "utf8",
    });
  }

  describe.each(["macos-boot", "linux-boot", "linux-wake"] as const)("%s", (type) => {
    it.each([
      { failures: 0, attempts: 1, ok: true },
      { failures: 2, attempts: 3, ok: true },
      { failures: 4, attempts: 5, ok: true },
      { failures: 99, attempts: 5, ok: false },
    ])("$failures failure(s) -> $attempts attempt(s)", ({ failures, attempts, ok }) => {
      stub(failures);
      const res = run(shPayload(type));
      expect(res.stderr).toBe("");
      expect(calls()).toBe(attempts);
      // Backoff between attempts, and none once it has succeeded or given up.
      expect(read("sleeps")).toEqual(["5", "10", "15", "20"].slice(0, attempts - 1));
      expect(res.status === 0).toBe(ok);
      // Every attempt is the same request, to the key's URL.
      for (const args of read("args")) {
        expect(args).toContain(`X-Mantis-Source: ${type}`);
        expect(args).toContain("X-Mantis-Host: testhost");
        expect(args.endsWith(input.url)).toBe(true);
      }
    });
  });

  it("macos-wake retries in the background and does not hold sleepwatcher up", async () => {
    stub(2);
    const { content } = buildInstaller("macos-wake", input);
    const res = run(content);
    // The hook itself returns straight away, whatever the request does.
    expect(res.status).toBe(0);
    expect(res.stderr).toBe("");
    const deadline = Date.now() + 30_000;
    while (read("sleeps").length < 2 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    while (calls() < 3 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    await new Promise((r) => setTimeout(r, 200));
    expect(calls()).toBe(3);
    expect(read("sleeps")).toEqual(["5", "10"]);
    expect(read("args")[0]).toContain("X-Mantis-Source: macos-wake");
    expect(read("args")[0]).toContain("X-Mantis-User: alice");
  });
});

describe("one-shot boot/wake alarms", () => {
  it.each(["linux-boot", "linux-wake"] as const)(
    "%s waits for the network and gives systemd nothing to substitute",
    (type) => {
      const { content } = buildInstaller(type, input);
      const after = /^After=(.*)$/m.exec(content)![1]!.split(" ");
      expect(after).toContain("network-online.target");
      expect(content).toMatch(/^Wants=network-online\.target$/m);
      // Plain INI the unit loader accepts: sections, then Key=Value lines.
      for (const line of content.split("\n")) {
        if (line === "" || /^\[(Unit|Service|Install)\]$/.test(line)) continue;
        expect(line).toMatch(/^[A-Za-z]+=\S/);
      }
      expect(content.match(/^ExecStart=/gm)).toHaveLength(1);
      // systemd expands ${VAR} (and $VAR as a word of its own) in ExecStart
      // before the shell ever sees the line. The only "$" left for it to look
      // at is the command substitution, which it passes through.
      const payload = shPayload(type);
      expect(payload.replaceAll("$(hostname)", "")).not.toContain("$");
      // …and the payload has no single quote to end systemd's quoting early.
      expect(payload).not.toContain("'");
    },
  );

  it("linux-boot does not hold the boot while it retries", () => {
    // multi-user.target is ordered after the units it wants. A oneshot counts
    // as started only when it exits, so the retry chain would keep the target
    // waiting for up to ~100s; a simple service counts as started at fork.
    const { content, notes } = buildInstaller("linux-boot", input);
    expect(content).toMatch(/^WantedBy=multi-user\.target$/m);
    expect(content).toMatch(/^Type=simple$/m);
    expect(content).not.toMatch(/^Type=oneshot$/m);
    // Nothing that would make the manager wait for, or restart, the ping.
    expect(content).not.toMatch(/^(RemainAfterExit|Restart|ExecStartPre|ExecStartPost)=/m);
    expect(notes).toMatch(/does not hold up the boot/);
  });

  it("linux-wake still follows the sleep targets, so nothing waits on it", () => {
    const { content } = buildInstaller("linux-wake", input);
    const after = /^After=(.*)$/m.exec(content)![1]!.split(" ");
    const wantedBy = /^WantedBy=(.*)$/m.exec(content)![1]!.split(" ");
    expect(wantedBy).toEqual(["suspend.target", "hibernate.target", "hybrid-sleep.target"]);
    // Ordered after every target that wants it: systemd then adds no implicit
    // "target After= unit" ordering, so the oneshot blocks nothing.
    for (const t of wantedBy) expect(after).toContain(t);
    expect(content).toMatch(/^Type=oneshot$/m);
  });

  it("is a fixed chain of at most five attempts, not a loop", () => {
    for (const type of ["macos-boot", "macos-wake", "linux-boot", "linux-wake"] as const) {
      const { content } = buildInstaller(type, input);
      // The executable part: the sh -c payload, or the hook minus its comments.
      const code =
        type === "macos-wake"
          ? content.split("\n").filter((l) => !l.startsWith("#")).join("\n")
          : shPayload(type);
      expect(code, type).not.toMatch(/\b(while|until|for)\b/);
      expect(content.match(/sleep \d+/g), type).toEqual([
        "sleep 5",
        "sleep 10",
        "sleep 15",
        "sleep 20",
      ]);
    }
  });

  it("leaves the steady-state alarms as a single attempt", () => {
    for (const type of [
      "shell",
      "shell-sudo",
      "macos-login",
      "macos-network",
      "linux-network",
    ] as const) {
      const { content } = buildInstaller(type, input);
      expect(content, type).not.toMatch(/sleep|mantis_fire/);
    }
  });
});
