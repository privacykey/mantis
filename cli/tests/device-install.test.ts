import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Nothing in this file may ever launch an install script.
const spawn = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawn,
}));

import {
  applyBundleLocally,
  writeBundleTo,
  type LocalBundleFiles,
} from "../src/lib/device-install.js";

const posix = process.platform !== "win32";
const mode = (path: string) => statSync(path).mode & 0o777;

function bundle(overrides: Partial<LocalBundleFiles> = {}): LocalBundleFiles {
  return {
    installScript: "install.sh",
    uninstallScript: "uninstall.sh",
    files: {
      "README.txt": "read me",
      "install.sh": "#!/bin/sh\necho install\n",
      "uninstall.sh": "#!/bin/sh\necho uninstall\n",
      "vectors/login/mantis.sh": "curl https://mantis.example.com/c/abc12345\n",
    },
    ...overrides,
  };
}

let scratch: string;
let dir: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "mantis-device-install-test-"));
  dir = join(scratch, "bundle");
  mkdirSync(dir);
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  rmSync(scratch, { recursive: true, force: true });
});

describe("writeBundleTo", () => {
  it("writes a well-formed bundle and marks both scripts executable", async () => {
    await writeBundleTo(dir, bundle());
    expect(readFileSync(join(dir, "vectors/login/mantis.sh"), "utf8")).toContain("/c/abc12345");
    expect(readdirSync(dir).sort()).toEqual(["README.txt", "install.sh", "uninstall.sh", "vectors"]);
    if (posix) {
      expect(mode(join(dir, "install.sh"))).toBe(0o755);
      expect(mode(join(dir, "uninstall.sh"))).toBe(0o755);
      expect(mode(join(dir, "README.txt")) & 0o111).toBe(0);
    }
  });

  it("refuses a sibling-directory path that only shares the bundle directory's prefix", async () => {
    // `<dir>-sibling` starts with `<dir>` as a string, but is not inside it.
    const sibling = `${dir}-sibling`;
    const b = bundle();
    b.files[`../${basename(dir)}-sibling/x`] = "escaped";

    await expect(writeBundleTo(dir, b)).rejects.toThrow("outside the bundle directory");

    expect(existsSync(sibling)).toBe(false);
    // Validated as a whole, before the first write: not even the good files landed.
    expect(readdirSync(dir)).toEqual([]);
  });

  it.each([
    ["an absolute path", { files: { ...bundle().files, [join(tmpdir(), "abs.txt")]: "x" } }],
    ["a parent path", { files: { ...bundle().files, "../up.txt": "x" } }],
    ["a path that resolves to the bundle root", { files: { ...bundle().files, "vectors/..": "x" } }],
    ["a path with control characters", { files: { ...bundle().files, ["a\nb.txt"]: "x" } }],
    ["an empty path", { files: { ...bundle().files, "": "x" } }],
    ["non-text content", { files: { ...bundle().files, "n.txt": 7 as unknown as string } }],
    ["the same path twice (case-folded)", { files: { ...bundle().files, "readme.TXT": "x" } }],
    ["a path that is both file and directory", { files: { ...bundle().files, "vectors/login": "x" } }],
    ["an install script outside the bundle", { installScript: "../../install.sh" }],
    ["an install script the bundle does not ship", { installScript: "setup.sh" }],
    ["an uninstall script the bundle does not ship", { uninstallScript: "vectors" }],
    ["a missing file map", { files: undefined as unknown as Record<string, string> }],
  ])("refuses %s and writes nothing", async (_name, overrides) => {
    await expect(writeBundleTo(dir, bundle(overrides))).rejects.toThrow("refusing the device bundle");
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe("applyBundleLocally", () => {
  it.skipIf(!posix)(
    "does not chmod a path outside the staging directory named as a script",
    async () => {
      // An operator-owned private file in a private directory, somewhere else.
      const privateDir = join(scratch, "private");
      mkdirSync(privateDir, { mode: 0o700 });
      const secret = join(privateDir, "id_ed25519");
      writeFileSync(secret, "dummy", { mode: 0o600 });
      chmodSync(privateDir, 0o700);
      chmodSync(secret, 0o600);

      // join() collapses the leading ../ run back to the filesystem root.
      const escape = (target: string) => "../".repeat(30) + target.replace(/^\//, "");
      const hostile = bundle({
        installScript: escape(privateDir),
        uninstallScript: escape(secret),
      });

      await expect(applyBundleLocally(hostile, { assumeYes: true })).rejects.toThrow(
        "refusing the device bundle",
      );

      expect(mode(secret)).toBe(0o600);
      expect(mode(privateDir)).toBe(0o700);
      expect(spawn).not.toHaveBeenCalled();
    },
  );

  it.skipIf(!posix)("refuses the same bundle when the script names are also file keys", async () => {
    const secret = join(scratch, "secret.txt");
    writeFileSync(secret, "dummy", { mode: 0o600 });
    chmodSync(secret, 0o600);
    const rel = "../".repeat(30) + secret.replace(/^\//, "");
    const hostile = bundle({ uninstallScript: rel });
    hostile.files[rel] = "overwritten";

    await expect(applyBundleLocally(hostile, { assumeYes: true })).rejects.toThrow(
      "outside the bundle directory",
    );

    expect(readFileSync(secret, "utf8")).toBe("dummy");
    expect(mode(secret)).toBe(0o600);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("runs only the staged, contained install script once the bundle checks out", async () => {
    spawn.mockImplementation(() => ({
      on(event: string, cb: (code: number) => void) {
        if (event === "close") queueMicrotask(() => cb(0));
        return this;
      },
    }));

    await expect(applyBundleLocally(bundle(), { assumeYes: true })).resolves.toBe(true);

    expect(spawn).toHaveBeenCalledTimes(1);
    const [, args, opts] = spawn.mock.calls[0]! as [string, string[], { cwd: string }];
    const script = args[args.length - 1]!;
    try {
      expect(basename(script)).toBe("install.sh");
      expect(dirname(script)).toBe(opts.cwd);
      expect(basename(opts.cwd)).toMatch(/^mantis-device-/);
      expect(readFileSync(script, "utf8")).toContain("echo install");
    } finally {
      rmSync(opts.cwd, { recursive: true, force: true });
    }
  });
});
