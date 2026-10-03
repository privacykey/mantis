import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildDeviceBundleFiles,
  type BundleVector,
} from "@mantis/core/device-bundle-files";
import {
  DEVICE_PROFILES,
  deviceMemo,
  getDeviceProfile,
  type DeviceOs,
} from "@mantis/core/device-profiles";
import { buildInstaller } from "@mantis/core/installers";

// The device bundle's bootstrap scripts are generated text. These tests look
// at what the scripts DO: the POSIX ones are run for real, inside a sandbox
// where $HOME is a temp directory and PATH holds nothing but a handful of
// ordinary file tools plus stand-ins for everything that reports or changes
// identity (id, getent, dscl, stat, sudo, runuser, launchctl). That lets a
// "root" run be exercised without being root. The PowerShell script cannot be
// run here, so its checks are on the text.

const KEY_ID = "3f7c1a2b-4d5e-6f70-8192-a3b4c5d6e7f8";
const URL = "https://mantis.example.com/c/abc123";

function vectorsFor(os: DeviceOs, slugs?: string[]): BundleVector[] {
  const profile = getDeviceProfile(os);
  const chosen = slugs
    ? profile.vectors.filter((v) => slugs.includes(v.slug))
    : profile.vectors;
  return chosen.map((vector, i) => {
    const keyId = `${KEY_ID.slice(0, 35)}${i.toString(16)}`;
    const memo = deviceMemo("web01", vector);
    return {
      vector,
      key: { id: keyId, publicId: `pub${i}`, memo },
      installer: buildInstaller(vector.installType, { url: URL, keyId, memo }),
    };
  });
}

const bundle = (os: DeviceOs, slugs?: string[]) =>
  buildDeviceBundleFiles({ deviceName: "web01", os, vectors: vectorsFor(os, slugs) });

/* -------------------------------------------------------------------------- */
/* Windows: install.ps1                                                        */
/* -------------------------------------------------------------------------- */

describe("windows install.ps1", () => {
  const ps1 = bundle("windows").files["install.ps1"]!;
  const lines = ps1.split("\r\n");

  it("judges every schtasks call by its exit code", () => {
    // One helper runs schtasks and returns $LASTEXITCODE; nothing calls
    // schtasks any other way, so no registration can fail unnoticed.
    expect(ps1).toContain("function Invoke-Schtasks {");
    expect(ps1).toContain("return $LASTEXITCODE");
    const direct = lines.filter(
      (l) =>
        /schtasks/i.test(l) &&
        !/^\s*(#|Write-Warning )/.test(l) &&
        !/Invoke-Schtasks|schtasks\.exe @args|\$schtasksOutput = ''/.test(l),
    );
    expect(direct).toEqual([]);
    // Windows PowerShell 5.1 turns redirected native stderr into a terminating
    // error under 'Stop'; the helper runs under 'Continue' instead of
    // redirecting at the call site.
    expect(ps1).not.toContain("2>$null");
    expect(ps1).toMatch(/function Invoke-Schtasks \{\r\n\s+\$ErrorActionPreference = 'Continue'/);
  });

  it("does not count the pre-delete, and confirms the task exists afterwards", () => {
    const fn = ps1.slice(
      ps1.indexOf("function Register-MantisTask"),
      ps1.indexOf("# --- "),
    );
    // delete: result discarded. create and query: both decide the outcome.
    expect(fn).toMatch(/\$null = Invoke-Schtasks \/delete \/tn \$Task \/f/);
    const create = fn.indexOf("$code = Invoke-Schtasks /create /tn $Task /xml $Xml");
    const query = fn.indexOf("$code = Invoke-Schtasks /query /tn $Task");
    expect(create).toBeGreaterThan(0);
    expect(query).toBeGreaterThan(create);
    expect(fn.match(/if \(\$code -ne 0\) \{\r\n\s+Write-Warning .*\r\n\s+return \$false/g)).toHaveLength(2);
    expect(fn.trimEnd().endsWith("return $true\r\n}")).toBe(true);
  });

  it("counts a failure per vector and exits non-zero", () => {
    for (const bv of vectorsFor("windows")) {
      const id = bv.key.id.slice(0, 8);
      const name = { logon: "Logon", wake: "Wake", network: "Network" }[bv.vector.slug]!;
      expect(lines).toContain(
        `if (-not (Register-MantisTask 'Mantis ${name} ${id}' "$bundle\\vectors\\${bv.vector.slug}\\${bv.installer.filename}")) { $failed++ }`,
      );
    }
    const tail = lines.slice(-7).join("\n");
    expect(tail).toBe(
      [
        "",
        "if ($failed -gt 0) {",
        '  Write-Host "done, with $failed vector(s) needing attention."',
        "  exit 2",
        "}",
        'Write-Host "done."',
        "",
      ].join("\n"),
    );
  });

  it("stays ASCII with balanced braces", () => {
    // Written as BOM-less UTF-8 and read by Windows PowerShell 5.1 in the
    // ANSI code page: anything outside ASCII would be mangled.
    expect(ps1).toMatch(/^[\x09\x0a\x0d\x20-\x7e]*$/);
    const count = (ch: string) => ps1.split(ch).length - 1;
    expect(count("{")).toBe(count("}"));
    expect(count("(")).toBe(count(")"));
  });
});

/* -------------------------------------------------------------------------- */
/* POSIX: install.sh / uninstall.sh                                            */
/* -------------------------------------------------------------------------- */

const posix = process.platform !== "win32";

/** Real tools the scripts may use. Everything else on PATH is a stand-in. */
const REAL_TOOLS = [
  "sh", "cat", "grep", "mkdir", "basename", "dirname", "chmod", "rm", "sed",
  "cut", "install", "mv", "env", "test",
];

const STUBS: Record<string, string> = {
  id: `case "$1" in
  -un) if [ "$FAKE_UID" = 0 ]; then echo root; else echo alice; fi; exit 0 ;;
  -u) ;;
  *) exit 64 ;;
esac
case "\${2:-}" in
  "") echo "$FAKE_UID" ;;
  alice) echo 1000 ;;
  root) echo 0 ;;
  *) exit 1 ;;
esac`,
  getent: `[ "$1" = passwd ] || exit 2
case "$2" in
  alice) echo "alice:x:1000:1000:Alice:$FAKE_ROOT/home/alice:/bin/bash" ;;
  root) echo "root:x:0:0:root:$FAKE_ROOT/root:/bin/sh" ;;
  *) exit 2 ;;
esac`,
  dscl: `[ "$1" = "." ] && [ "$2" = "-read" ] || exit 64
case "$3:$4" in
  /Users/alice:NFSHomeDirectory) echo "NFSHomeDirectory: $FAKE_ROOT/home/alice" ;;
  /Users/alice:UserShell) echo "UserShell: /bin/zsh" ;;
  /Users/root:NFSHomeDirectory) echo "NFSHomeDirectory: $FAKE_ROOT/root" ;;
  /Users/root:UserShell) echo "UserShell: /bin/sh" ;;
  *) exit 56 ;;
esac`,
  stat: `[ "$*" = "-f %Su /dev/console" ] || exit 64
echo "$FAKE_CONSOLE"`,
  // The three below log "<identity>| <command line>". The identity is "self"
  // (whoever started the script) until runuser/sudo hand over to a user.
  runuser: `echo "\${FAKE_AS:-self}| runuser $*" >> "$FAKE_LOG"
[ "$1" = "-u" ] && [ "$3" = "--" ] || exit 64
FAKE_AS="$2"; export FAKE_AS
shift 3
exec "$@"`,
  sudo: `echo "\${FAKE_AS:-self}| sudo $*" >> "$FAKE_LOG"
[ "$1" = "-u" ] || exit 64
FAKE_AS="$2"; export FAKE_AS
shift 2
exec "$@"`,
  launchctl: `echo "\${FAKE_AS:-self}| launchctl $*" >> "$FAKE_LOG"
if [ "$1" = asuser ]; then shift 2; exec "$@"; fi
exit 0`,
};

// These spawn a shell per case; allow for a loaded machine.
describe.skipIf(!posix)("posix bootstrap scripts", { timeout: 60_000 }, () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "mantis-bundle-"));
    mkdirSync(join(root, "home/alice"), { recursive: true });
    mkdirSync(join(root, "root"), { recursive: true });
    mkdirSync(join(root, "bin"));
    for (const tool of REAL_TOOLS) {
      const real = ["/bin", "/usr/bin"].map((d) => join(d, tool)).find(existsSync);
      if (!real) throw new Error(`this test needs ${tool}`);
      symlinkSync(real, join(root, "bin", tool));
    }
    for (const [name, body] of Object.entries(STUBS)) {
      writeFileSync(join(root, "bin", name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    }
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function stage(os: DeviceOs, slugs: string[]): string {
    const dir = join(root, "stage");
    for (const [rel, content] of Object.entries(bundle(os, slugs).files)) {
      mkdirSync(dirname(join(dir, rel)), { recursive: true });
      writeFileSync(join(dir, rel), content);
    }
    return dir;
  }

  type Who = {
    /** What `id -u` reports for the caller. */
    uid: 0 | 1000;
    env?: Record<string, string>;
    /** Stand-ins to take off PATH for this run. */
    without?: string[];
  };

  function run(dir: string, script: "install.sh" | "uninstall.sh", who: Who) {
    for (const name of who.without ?? []) rmSync(join(root, "bin", name));
    const asRoot = who.uid === 0;
    const res = spawnSync("/bin/sh", [join(dir, script)], {
      encoding: "utf8",
      env: {
        PATH: join(root, "bin"),
        HOME: join(root, asRoot ? "root" : "home/alice"),
        SHELL: asRoot ? "/bin/sh" : "/bin/bash",
        MANTIS_ASSUME_YES: "1",
        FAKE_UID: String(who.uid),
        FAKE_ROOT: root,
        FAKE_LOG: join(root, "log"),
        FAKE_CONSOLE: "root",
        ...who.env,
        // Only because the env type requires it; the scripts never read it.
        NODE_ENV: "test",
      },
    });
    const log = existsSync(join(root, "log"))
      ? readFileSync(join(root, "log"), "utf8").trim().split("\n")
      : [];
    return { ...res, out: res.stdout + res.stderr, log };
  }

  const alice = (rel = "") => join(root, "home/alice", rel);
  const rootHome = (rel = "") => join(root, "root", rel);
  const text = (path: string) => readFileSync(path, "utf8");
  const SHELL_BLOCK = [
    "# >>> mantis:shell >>>",
    '[ -f "$HOME/.mantis.sh" ] && . "$HOME/.mantis.sh"',
    "# <<< mantis:shell <<<",
  ].join("\n");

  it.each(DEVICE_PROFILES.filter((p) => p.os !== "windows").map((p) => p.os))(
    "%s scripts parse as POSIX sh",
    (os) => {
      const dir = stage(os, getDeviceProfile(os).vectors.map((v) => v.slug));
      for (const script of ["install.sh", "uninstall.sh"]) {
        const res = spawnSync("/bin/sh", ["-n", join(dir, script)], { encoding: "utf8" });
        expect(res.stderr, script).toBe("");
        expect(res.status, script).toBe(0);
      }
    },
  );

  describe("linux, run as the user (the documented path)", () => {
    it("installs into the caller's home with plain commands, idempotently", () => {
      const dir = stage("linux", ["login", "sudo"]);
      const first = run(dir, "install.sh", { uid: 1000 });
      expect(first.out).not.toContain("Running as root");
      expect(first.status, first.out).toBe(0);
      expect(first.log).toEqual([]);

      expect(text(alice(".mantis.sh"))).toBe(text(join(dir, "vectors/login/mantis.sh")));
      expect(statSync(alice(".mantis.sh")).mode & 0o777).toBe(0o600);
      expect(statSync(alice(".mantis-sudo.sh")).mode & 0o777).toBe(0o600);
      // The rc line is evaluated by the user's own shell later, so it must
      // say $HOME — not a variable that only exists inside install.sh.
      expect(text(alice(".bashrc"))).toContain(SHELL_BLOCK);

      const again = run(dir, "install.sh", { uid: 1000 });
      expect(again.status, again.out).toBe(0);
      expect(again.out).toContain("already sourced");
      expect(text(alice(".bashrc")).split("# >>> mantis:shell >>>")).toHaveLength(2);

      const removed = run(dir, "uninstall.sh", { uid: 1000 });
      expect(removed.status, removed.out).toBe(0);
      expect(existsSync(alice(".mantis.sh"))).toBe(false);
      expect(text(alice(".bashrc"))).not.toContain("mantis");
    });
  });

  describe("linux, run as root", () => {
    it("installs the per-user alarms for the sudo caller, as that user", () => {
      const dir = stage("linux", ["login", "sudo"]);
      const res = run(dir, "install.sh", { uid: 0, env: { SUDO_USER: "alice" } });
      expect(res.status, res.out).toBe(0);
      expect(res.out).toContain(
        `Running as root: per-user alarms will be installed for alice (${alice()}).`,
      );

      expect(text(alice(".mantis.sh"))).toBe(text(join(dir, "vectors/login/mantis.sh")));
      expect(statSync(alice(".mantis.sh")).mode & 0o777).toBe(0o600);
      // alice's login shell is bash; root's ($SHELL here) is sh. Her rc file.
      expect(text(alice(".bashrc"))).toContain(SHELL_BLOCK);
      expect(existsSync(alice(".profile"))).toBe(false);
      // Nothing lands in root's home.
      expect(readdirSync(rootHome())).toEqual([]);

      // Every write into her home went through the privilege drop.
      expect(res.log.length).toBeGreaterThan(0);
      for (const entry of res.log) {
        expect(entry.startsWith(`self| runuser -u alice -- env HOME=${alice()} `), entry).toBe(true);
      }

      const removed = run(dir, "uninstall.sh", { uid: 0, env: { SUDO_USER: "alice" } });
      expect(removed.status, removed.out).toBe(0);
      expect(removed.out).toContain("per-user alarms will be removed for alice");
      expect(existsSync(alice(".mantis.sh"))).toBe(false);
      expect(existsSync(alice(".mantis-sudo.sh"))).toBe(false);
      expect(text(alice(".bashrc"))).not.toContain("mantis");
    });

    it("replaces a destination the user cannot write through", () => {
      // A leftover from an earlier root run: present, and (as far as this
      // sandbox can show) read-only to the user.
      writeFileSync(alice(".mantis.sh"), "stale\n", { mode: 0o400 });
      const dir = stage("linux", ["login"]);
      const res = run(dir, "install.sh", { uid: 0, env: { SUDO_USER: "alice" } });
      expect(res.status, res.out).toBe(0);
      expect(text(alice(".mantis.sh"))).toBe(text(join(dir, "vectors/login/mantis.sh")));
      expect(statSync(alice(".mantis.sh")).mode & 0o777).toBe(0o600);
    });

    it("falls back to sudo -u when runuser is missing", () => {
      const dir = stage("linux", ["login"]);
      const res = run(dir, "install.sh", {
        uid: 0,
        env: { SUDO_USER: "alice" },
        without: ["runuser"],
      });
      expect(res.status, res.out).toBe(0);
      expect(existsSync(alice(".mantis.sh"))).toBe(true);
      expect(res.log.length).toBeGreaterThan(0);
      for (const entry of res.log) {
        expect(entry.startsWith(`self| sudo -u alice env HOME=${alice()} `), entry).toBe(true);
      }
    });

    // A root-only server or container is a normal place to run this: root
    // logs in directly, and root is the account whose shells should be watched.
    it.each([
      ["root is logged in directly (no sudo caller)", {}],
      ["the sudo caller is root itself", { SUDO_USER: "root" }],
    ])("acts for root when %s", (_label, env) => {
      const dir = stage("linux", ["login", "sudo"]);
      // A misleading environment, as sudo can leave behind: the home and the
      // login shell have to come from the user database, not from here.
      const res = run(dir, "install.sh", {
        uid: 0,
        env: { ...env, HOME: alice(), SHELL: "/bin/zsh" },
      });
      expect(res.status, res.out).toBe(0);
      expect(res.out).toContain(
        `Running as root: per-user alarms will be installed for root (${rootHome()}). ` +
          "Set MANTIS_TARGET_USER=<name> to watch another account instead.",
      );
      expect(res.out).not.toContain("skipped");
      expect(res.out).toMatch(/^done\.$/m);

      expect(text(rootHome(".mantis.sh"))).toBe(text(join(dir, "vectors/login/mantis.sh")));
      expect(statSync(rootHome(".mantis.sh")).mode & 0o777).toBe(0o600);
      expect(existsSync(rootHome(".mantis-sudo.sh"))).toBe(true);
      // root's login shell in the database is sh: .profile, not $SHELL's .zshrc.
      expect(text(rootHome(".profile"))).toContain(SHELL_BLOCK);
      expect(existsSync(rootHome(".zshrc"))).toBe(false);
      expect(readdirSync(alice())).toEqual([]);
      // Root acting for root: there is no privilege drop to go through.
      expect(res.log).toEqual([]);

      const removed = run(dir, "uninstall.sh", { uid: 0, env });
      expect(removed.status, removed.out).toBe(0);
      expect(removed.out).toContain(
        `Running as root: per-user alarms will be removed for root (${rootHome()}). ` +
          "Set MANTIS_TARGET_USER=<name> to remove them from another account instead.",
      );
      expect(existsSync(rootHome(".mantis.sh"))).toBe(false);
      expect(existsSync(rootHome(".mantis-sudo.sh"))).toBe(false);
      expect(text(rootHome(".profile"))).not.toContain("mantis");
    });

    it("says who the alarms are for before it asks to continue", () => {
      const sh = text(join(stage("linux", ["login"]), "install.sh"));
      const note = sh.indexOf('[ -z "$USER_NOTE" ] || say "$USER_NOTE"');
      expect(note).toBeGreaterThan(0);
      expect(note).toBeLessThan(sh.indexOf('printf "Continue? [y/N] "'));
    });

    // Skipping (and failing) is kept for the cases with no usable account.
    it.each([
      ["the sudo caller is unknown", { SUDO_USER: "ghost" }, "could not find a home directory for 'ghost'."],
      ["the named target is unknown", { MANTIS_TARGET_USER: "ghost" }, "could not find a home directory for 'ghost'."],
    ])("skips them, loudly and non-zero, when %s", (_label, env, why) => {
      const dir = stage("linux", ["login", "sudo"]);
      const res = run(dir, "install.sh", { uid: 0, env });
      expect(res.status, res.out).toBe(2);
      expect(res.out).toContain(`Running as root: per-user alarms will NOT be installed - ${why}`);
      expect(res.out.match(/ {2}! skipped: /g)).toHaveLength(2);
      expect(res.out).toContain("done, with 2 vector(s) needing attention");
      expect(res.out).not.toMatch(/^done\.$/m);
      // Nobody's shells are armed by accident.
      expect(readdirSync(rootHome())).toEqual([]);
      expect(readdirSync(alice())).toEqual([]);
      expect(res.log).toEqual([]);
    });

    it("skips them when the account has no home directory", () => {
      rmSync(rootHome(), { recursive: true });
      const dir = stage("linux", ["login"]);
      const res = run(dir, "install.sh", { uid: 0 });
      expect(res.status, res.out).toBe(2);
      expect(res.out).toContain("could not find a home directory for 'root'.");
      expect(existsSync(rootHome())).toBe(false);
      expect(readdirSync(alice())).toEqual([]);
    });

    it("skips them when it cannot become the target", () => {
      const dir = stage("linux", ["login"]);
      const res = run(dir, "install.sh", {
        uid: 0,
        env: { SUDO_USER: "alice" },
        without: ["runuser", "sudo"],
      });
      expect(res.status, res.out).toBe(2);
      expect(res.out).toContain("cannot act as 'alice': neither runuser nor sudo is available.");
      expect(readdirSync(alice())).toEqual([]);
      expect(readdirSync(rootHome())).toEqual([]);
    });

    it("lets an explicit MANTIS_TARGET_USER override the sudo caller", () => {
      const dir = stage("linux", ["login"]);

      // root named outright while alice ran sudo: root it is, and no hint
      // about how to pick someone else - the operator just did.
      const asRoot = run(dir, "install.sh", {
        uid: 0,
        env: { MANTIS_TARGET_USER: "root", SUDO_USER: "alice" },
      });
      expect(asRoot.status, asRoot.out).toBe(0);
      expect(asRoot.out).toContain(`per-user alarms will be installed for root (${rootHome()}).\n`);
      expect(asRoot.out).not.toContain("to watch another account");
      expect(existsSync(rootHome(".mantis.sh"))).toBe(true);
      expect(text(rootHome(".profile"))).toContain(SHELL_BLOCK);
      expect(readdirSync(alice())).toEqual([]);
      expect(asRoot.log).toEqual([]);

      // alice named outright from a direct root login.
      const asAlice = run(dir, "install.sh", { uid: 0, env: { MANTIS_TARGET_USER: "alice" } });
      expect(asAlice.status, asAlice.out).toBe(0);
      expect(asAlice.out).toContain(`per-user alarms will be installed for alice (${alice()}).\n`);
      expect(existsSync(alice(".mantis.sh"))).toBe(true);
      expect(asAlice.log.length).toBeGreaterThan(0);
    });
  });

  describe("macos, run as root", () => {
    const plist = "Library/LaunchAgents/com.mantis.login.3f7c1a2b.plist";

    it("uses the console user and loads the agent in that user's session", () => {
      const dir = stage("macos", ["login", "desktop-login"]);
      const res = run(dir, "install.sh", { uid: 0, env: { FAKE_CONSOLE: "alice" } });
      expect(res.status, res.out).toBe(0);
      expect(res.out).toContain(`per-user alarms will be installed for alice (${alice()}).`);

      expect(existsSync(alice(plist))).toBe(true);
      expect(statSync(alice(plist)).mode & 0o777).toBe(0o644);
      // alice's login shell (from dscl) is zsh.
      expect(text(alice(".zshrc"))).toContain(SHELL_BLOCK);
      expect(readdirSync(rootHome())).toEqual([]);

      // Root asks for her launchd session and drops to her before loading…
      expect(res.log).toContain(
        `self| launchctl asuser 1000 sudo -u alice launchctl load ${alice(plist)}`,
      );
      expect(res.log).toContain(`alice| launchctl load ${alice(plist)}`);
      // …and never loads or unloads anything as root itself.
      expect(res.log.filter((l) => /^self\| launchctl (load|unload)/.test(l))).toEqual([]);
    });

    it("prefers the sudo caller over the console user", () => {
      const dir = stage("macos", ["login"]);
      const res = run(dir, "install.sh", {
        uid: 0,
        env: { SUDO_USER: "alice", FAKE_CONSOLE: "root" },
      });
      expect(res.status, res.out).toBe(0);
      expect(existsSync(alice(".mantis.sh"))).toBe(true);
    });

    it.each(["root", "loginwindow", "_mbsetupuser", ""])(
      "skips them when the console belongs to %j",
      (consoleUser) => {
        const dir = stage("macos", ["login", "desktop-login"]);
        const res = run(dir, "install.sh", { uid: 0, env: { FAKE_CONSOLE: consoleUser } });
        expect(res.status, res.out).toBe(2);
        expect(res.out).toContain("per-user alarms will NOT be installed");
        expect(readdirSync(rootHome())).toEqual([]);
        expect(readdirSync(alice())).toEqual([]);
        expect(res.log).toEqual([]);
      },
    );

    it("is unchanged for a normal user run", () => {
      const dir = stage("macos", ["login", "desktop-login"]);
      const res = run(dir, "install.sh", { uid: 1000 });
      expect(res.status, res.out).toBe(0);
      expect(existsSync(alice(plist))).toBe(true);
      expect(res.log).toEqual([
        `self| launchctl unload ${alice(plist)}`,
        `self| launchctl load ${alice(plist)}`,
      ]);
    });
  });
});
