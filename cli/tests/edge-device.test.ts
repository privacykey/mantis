import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { edgeDeviceCmd } from "../src/commands/edge-device.js";
import { setJsonMode } from "../src/lib/out.js";

// A fixed 32-byte AES key, passed via --edge-key so no keychain is touched.
const KEY_RAW = new Uint8Array(32).fill(7);
const KEY_B64 = Buffer.from(KEY_RAW).toString("base64url");
const WORKER = "https://edge.example.com";
const WEBHOOK = "https://hooks.example.com/notify";

const BASE = {
  worker: WORKER,
  webhook: WEBHOOK,
  key: KEY_B64,
};

/** Inverse of lib/edge-crypto's seal(): version byte + 12-byte nonce + ct/tag. */
async function open(url: string): Promise<Record<string, unknown>> {
  const blob = /\/c\/([A-Za-z0-9_-]+)$/.exec(url)?.[1];
  expect(blob, `not an edge URL: ${url}`).toBeTruthy();
  const raw = Buffer.from(blob!, "base64url");
  expect(raw[0]).toBe(0x01);
  const key = await crypto.subtle.importKey(
    "raw",
    KEY_RAW,
    { name: "AES-GCM" },
    false,
    ["decrypt"],
  );
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: raw.subarray(1, 13) },
    key,
    raw.subarray(13),
  );
  return JSON.parse(new TextDecoder().decode(pt)) as Record<string, unknown>;
}

type EmittedKey = {
  slug: string;
  memo: string;
  url: string;
  key_id: string;
  install_type: string;
};
type Emitted = {
  device: string;
  os: string;
  worker: string;
  keys: EmittedKey[];
  bundle: string | null;
  installed: boolean;
  not_on_edge: { fresh_urls_on_rerun: boolean; undeduped_vectors: string[] };
};

/** Run the command in JSON mode and parse what it emits to stdout. */
async function runJson(
  opts: Parameters<typeof edgeDeviceCmd>[0],
): Promise<Emitted> {
  const writes: string[] = [];
  const spy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation(((s: string) => {
      writes.push(String(s));
      return true;
    }) as never);
  setJsonMode(true);
  try {
    await edgeDeviceCmd(opts);
  } finally {
    setJsonMode(false);
    spy.mockRestore();
  }
  return JSON.parse(writes.join("")) as Emitted;
}

function expectExit(): { restore: () => void } {
  const spy = vi.spyOn(process, "exit").mockImplementation(((
    _code?: number,
  ) => {
    throw new Error("__test_exit__");
  }) as never);
  return { restore: () => spy.mockRestore() };
}

describe("edgeDeviceCmd", () => {
  beforeEach(() => {
    // fail() writes its message before exiting; keep test output clean.
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it("mints one distinct URL per default vector, response kind from the vector", async () => {
    const out = await runJson({ ...BASE, os: "macos", name: "web01" });

    // macOS defaults exclude `wake` (needs sleepwatcher) — armed-looking
    // alarms that silently can't fire stay opt-in.
    expect(out.keys.map((k) => k.slug)).toEqual([
      "login",
      "sudo",
      "desktop-login",
      "boot",
      "network",
    ]);
    expect(new Set(out.keys.map((k) => k.url)).size).toBe(out.keys.length);
    expect(out.installed).toBe(false);
    expect(out.bundle).toBeNull();

    const login = out.keys.find((k) => k.slug === "login")!;
    expect(login.install_type).toBe("shell");
    expect(login.url.startsWith(`${WORKER}/c/`)).toBe(true);
    const payload = await open(login.url);
    expect(payload).toEqual({
      w: WEBHOOK,
      r: "empty",
      m: "web01 — shell / SSH login",
    });
  });

  it("embeds the channel formatter when --channel is given", async () => {
    const out = await runJson({
      ...BASE,
      os: "linux",
      name: "db01",
      vectors: "login",
      channel: "discord",
    });
    expect(out.keys).toHaveLength(1);
    const payload = await open(out.keys[0]!.url);
    expect(payload.c).toBe("discord");
  });

  it("surfaces both not-on-edge properties in output", async () => {
    const out = await runJson({ ...BASE, os: "linux", name: "db01" });
    expect(out.not_on_edge.fresh_urls_on_rerun).toBe(true);
    // network is the only default vector with a server-side dedupe window.
    expect(out.not_on_edge.undeduped_vectors).toEqual(["network"]);

    // Human mode prints both notices…
    const err: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation(((s: string) => {
      err.push(String(s));
      return true;
    }) as never);
    await runHuman({ ...BASE, os: "linux", name: "db01" });
    const text = err.join("");
    expect(text).toContain("mints a FRESH set of URLs");
    expect(text).toContain("network normally dedupes hits in a 60s window");

    // …but the dedupe notice only for vectors that actually have a window.
    err.length = 0;
    await runHuman({ ...BASE, os: "linux", name: "db01", vectors: "login,sudo" });
    const quietText = err.join("");
    expect(quietText).toContain("mints a FRESH set of URLs");
    expect(quietText).not.toContain("normally dedupes");
  });

  it("writes the bundle as a directory with executable scripts", async () => {
    const parent = await mkdtemp(join(tmpdir(), "mantis-edge-device-test-"));
    const dir = join(parent, "web01");
    const out = await runJson({
      ...BASE,
      os: "macos",
      name: "web01",
      bundle: dir,
    });
    expect(out.bundle).toBe(dir);

    const readme = await readFile(join(dir, "README.txt"), "utf8");
    expect(readme).toContain('device bundle for "web01" (macos)');
    // No server: the README must not point at a dashboard.
    expect(readme).not.toContain("Dashboard:");

    for (const script of ["install.sh", "uninstall.sh"]) {
      const mode = (await stat(join(dir, script))).mode & 0o777;
      expect(mode, script).toBe(0o755);
    }

    // Each vector's installer file carries its own minted URL.
    for (const k of out.keys) {
      const files = await readFile(
        join(dir, "install.sh"),
        "utf8",
      );
      expect(files).toContain(`vectors/${k.slug}/`);
    }
    const login = out.keys.find((k) => k.slug === "login")!;
    const snippet = await readFile(
      join(dir, "vectors", "login", "mantis.sh"),
      "utf8",
    );
    expect(snippet).toContain(login.url);
  });

  it("refuses a --bundle directory that already has contents", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mantis-edge-device-test-"));
    await writeFile(join(dir, "leftover.txt"), "old bundle");
    const exit = expectExit();
    try {
      await expect(
        runJson({ ...BASE, os: "macos", name: "web01", bundle: dir }),
      ).rejects.toThrow("__test_exit__");
    } finally {
      exit.restore();
    }
  });

  it("requires --os unless --install proves we're on the target machine", async () => {
    const exit = expectExit();
    try {
      await expect(runJson({ ...BASE, name: "web01" })).rejects.toThrow(
        "__test_exit__",
      );
    } finally {
      exit.restore();
    }
  });

  it("requires --name unless --install proves we're on the target machine", async () => {
    const exit = expectExit();
    try {
      await expect(runJson({ ...BASE, os: "macos" })).rejects.toThrow(
        "__test_exit__",
      );
    } finally {
      exit.restore();
    }
  });

  it("defaults os and name from this machine when --install is set (dry run)", async () => {
    // --dry-run returns before anything would touch the machine, so this
    // exercises the auto-OS + hostname defaults without running an installer.
    const writes: string[] = [];
    const spy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(((s: string) => {
        writes.push(String(s));
        return true;
      }) as never);
    setJsonMode(true);
    try {
      await edgeDeviceCmd({ ...BASE, install: true, dryRun: true });
    } finally {
      setJsonMode(false);
      spy.mockRestore();
    }
    const out = JSON.parse(writes.join("")) as {
      device: string;
      os: string;
      vectors: string[];
    };
    expect(out.device.length).toBeGreaterThan(0);
    expect(["macos", "linux", "windows"]).toContain(out.os);
    expect(out.vectors.length).toBeGreaterThan(0);
  });

  it("refuses --install for a profile that doesn't match this machine", async () => {
    const foreignOs = process.platform === "win32" ? "linux" : "windows";
    const exit = expectExit();
    try {
      await expect(
        runJson({ ...BASE, os: foreignOs, name: "web01", install: true }),
      ).rejects.toThrow("__test_exit__");
    } finally {
      exit.restore();
    }
  });

  it("rejects unknown vectors and --vectors with --all", async () => {
    const exit = expectExit();
    try {
      await expect(
        runJson({ ...BASE, os: "linux", name: "db01", vectors: "nope" }),
      ).rejects.toThrow("__test_exit__");
      await expect(
        runJson({
          ...BASE,
          os: "linux",
          name: "db01",
          vectors: "login",
          all: true,
        }),
      ).rejects.toThrow("__test_exit__");
    } finally {
      exit.restore();
    }
  });

  it("--all includes vectors needing extra setup", async () => {
    const out = await runJson({
      ...BASE,
      os: "macos",
      name: "web01",
      all: true,
    });
    expect(out.keys.map((k) => k.slug)).toContain("wake");
  });
});

/** Run the command in human mode (stdout/stderr already spied by the caller). */
async function runHuman(
  opts: Parameters<typeof edgeDeviceCmd>[0],
): Promise<void> {
  const spy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation(() => true);
  try {
    await edgeDeviceCmd(opts);
  } finally {
    spy.mockRestore();
  }
}
