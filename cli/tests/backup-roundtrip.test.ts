import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// ---------------------------------------------------------------------------
// In-memory keychain mock. Replaces @napi-rs/keyring everywhere it's
// imported so the test never touches the real OS keychain (no prompt on
// macOS, works in CI on Linux where libsecret may be absent).
// vi.mock is hoisted above all imports — including transitive imports from
// config.ts and edge-key.ts — so the mock is in place before any code
// under test sees the keyring module.
// ---------------------------------------------------------------------------

const keychain = new Map<string, string>();

vi.mock("@napi-rs/keyring", () => {
  class Entry {
    constructor(public service: string, public account: string) {}
    private storeKey(): string {
      return `${this.service}::${this.account}`;
    }
    getPassword(): string | null {
      return keychain.get(this.storeKey()) ?? null;
    }
    setPassword(value: string): void {
      keychain.set(this.storeKey(), value);
    }
    deletePassword(): void {
      keychain.delete(this.storeKey());
    }
  }
  return {
    Entry,
    findCredentialsAsync: async (service: string) => {
      const out: Array<{ account: string; password: string }> = [];
      for (const [k, v] of keychain.entries()) {
        const idx = k.indexOf("::");
        const s = k.slice(0, idx);
        const a = k.slice(idx + 2);
        if (s === service) out.push({ account: a, password: v });
      }
      return out;
    },
  };
});

// keychain-notice prints to stderr on first keychain access; silence it.
vi.mock("../src/lib/keychain-notice.js", () => ({
  maybeEmitKeychainNotice: () => {},
}));

// Plugin registry: restoreCmd calls pluginAddCmd which would try to clone
// the source repo. Stub it out for the round-trip test.
vi.mock("../src/commands/plugin.js", () => ({
  pluginAddCmd: vi.fn(async () => {}),
}));

// ---------------------------------------------------------------------------
// Per-suite setup: each test gets a fresh tmp XDG_CONFIG_HOME and a clean
// keychain. Modules are re-imported after env is set so config.ts picks up
// the right path.
// ---------------------------------------------------------------------------

let tmpHome: string;
const originalXdg = process.env.XDG_CONFIG_HOME;

beforeAll(async () => {
  // Silence the wizard's stderr writes during emit().
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});

afterAll(() => {
  if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalXdg;
  vi.restoreAllMocks();
});

beforeEach(async () => {
  tmpHome = await mkdtemp(join(tmpdir(), "mantis-backup-rt-"));
  process.env.XDG_CONFIG_HOME = tmpHome;
  keychain.clear();
  vi.resetModules();
});

afterEach(async () => {
  await rm(tmpHome, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helper: populate two profiles + an edge worker key + a CF Service-Auth
// blob through the public config API so the test mirrors what a real
// `mantis login` + `mantis edge set-key` would produce.
// ---------------------------------------------------------------------------

async function populateState(): Promise<void> {
  const config = await import("../src/lib/config.js");
  const edgeKey = await import("../src/lib/edge-key.js");

  // Profile "primary" — full configuration including CF Service-Auth + edge.
  config.setKey("https://primary.example.com", "mantis_live_primary_token_aaa");
  config.setCloudflareServiceAuth("https://primary.example.com", {
    client_id: "cf-client-id.access",
    client_secret: "cf-client-secret-shh",
  });
  edgeKey.setEdgeKey(
    "https://primary-edge.workers.dev",
    "MGYWRl0WT3RcVuQrMQuv4Ph9DcZakhfwHcZk0lszKnE",
  );
  await config.setProfile("primary", {
    baseUrl: "https://primary.example.com",
    keyPrefix: "mantis_live_primar",
    cloudflareAccessMode: "service-auth",
    cloudflareAccessAppUrl: "https://primary.example.com",
    edgeWorkerUrl: "https://primary-edge.workers.dev",
  });

  // Profile "backup" — minimal.
  config.setKey("https://backup.example.com", "mantis_live_backup_token_bbb");
  await config.setProfile("backup", {
    baseUrl: "https://backup.example.com",
    keyPrefix: "mantis_live_backup",
  });

  await config.useProfile("primary");
}

async function wipeState(): Promise<void> {
  const config = await import("../src/lib/config.js");
  await config.clearConfig();
  keychain.clear();
}

// ---------------------------------------------------------------------------
// Round-trip tests
// ---------------------------------------------------------------------------

describe("mantis backup → mantis restore round-trip", () => {
  it("round-trips independent edge keys without any server profile and preserves existing keys", async () => {
    const outPath = join(tmpHome, "edge-only.json");
    process.env.MANTIS_BACKUP_TEST_PASS = "edge-only-passphrase";
    const { setEdgeKey, getEdgeKey } = await import("../src/lib/edge-key.js");
    const worker = "https://standalone-edge.workers.dev";
    setEdgeKey(worker, "original-edge-key");
    const { backupCmd, restoreCmd } = await import("../src/commands/backup.js");
    await backupCmd({ out: outPath, passphraseEnv: "MANTIS_BACKUP_TEST_PASS" });
    await wipeState();
    await restoreCmd(outPath, { passphraseEnv: "MANTIS_BACKUP_TEST_PASS" });
    expect(getEdgeKey(worker)).toBe("original-edge-key");
    const config = await import("../src/lib/config.js");
    expect(await config.readConfig()).toBeNull();
    setEdgeKey(worker, "newer-local-key");
    await restoreCmd(outPath, { passphraseEnv: "MANTIS_BACKUP_TEST_PASS" });
    expect(getEdgeKey(worker)).toBe("newer-local-key");
    await restoreCmd(outPath, { passphraseEnv: "MANTIS_BACKUP_TEST_PASS", overwrite: true });
    expect(getEdgeKey(worker)).toBe("original-edge-key");
    delete process.env.MANTIS_BACKUP_TEST_PASS;
  }, 15_000);

  it("scopes --only to the selected profile's linked worker", async () => {
    await populateState();
    const { setEdgeKey } = await import("../src/lib/edge-key.js");
    setEdgeKey("https://independent.workers.dev", "independent-key");
    const { backupCmd } = await import("../src/commands/backup.js");
    const { openBundle } = await import("../src/lib/backup.js");
    const outPath = join(tmpHome, "scoped.json");
    process.env.MANTIS_BACKUP_TEST_PASS = "scope-passphrase";
    await backupCmd({ out: outPath, profile: "primary", passphraseEnv: "MANTIS_BACKUP_TEST_PASS" });
    const payload = await openBundle(JSON.parse(await readFile(outPath, "utf8")), "scope-passphrase");
    expect(payload.edgeWorkers?.map((worker) => worker.workerUrl)).toEqual(["https://primary-edge.workers.dev"]);
    expect(vi.mocked(process.stderr.write).mock.calls.join(" ")).toContain("omit --only to include independent edge workers");
    delete process.env.MANTIS_BACKUP_TEST_PASS;
  });

  it("restores old v1 bundles with edge keys embedded only in profiles", async () => {
    await populateState();
    const { collectBackupPayload, sealBundle } = await import("../src/lib/backup.js");
    const payload = await collectBackupPayload(undefined);
    delete payload.edgeWorkers;
    const outPath = join(tmpHome, "legacy.json");
    await writeFile(outPath, JSON.stringify(await sealBundle(payload, "legacy-passphrase")));
    await wipeState();
    process.env.MANTIS_BACKUP_TEST_PASS = "legacy-passphrase";
    const { restoreCmd } = await import("../src/commands/backup.js");
    await restoreCmd(outPath, { passphraseEnv: "MANTIS_BACKUP_TEST_PASS" });
    const { getEdgeKey } = await import("../src/lib/edge-key.js");
    expect(getEdgeKey("https://primary-edge.workers.dev")).toBe("MGYWRl0WT3RcVuQrMQuv4Ph9DcZakhfwHcZk0lszKnE");
    delete process.env.MANTIS_BACKUP_TEST_PASS;
  });

  it.each([false, true])("protects an existing independent worker key when restoring legacy profiles (overwrite=%s)", async (overwrite) => {
    await populateState();
    const { collectBackupPayload, sealBundle } = await import("../src/lib/backup.js");
    const payload = await collectBackupPayload(undefined);
    delete payload.edgeWorkers;
    const outPath = join(tmpHome, "legacy-existing-worker.json");
    await writeFile(outPath, JSON.stringify(await sealBundle(payload, "legacy-passphrase")));
    await wipeState();
    const { setEdgeKey, getEdgeKey } = await import("../src/lib/edge-key.js");
    const worker = "https://primary-edge.workers.dev";
    setEdgeKey(worker, "newer-independent-key");
    process.env.MANTIS_BACKUP_TEST_PASS = "legacy-passphrase";
    const { restoreCmd } = await import("../src/commands/backup.js");
    await restoreCmd(outPath, { passphraseEnv: "MANTIS_BACKUP_TEST_PASS", overwrite });
    expect(getEdgeKey(worker)).toBe(overwrite ? "MGYWRl0WT3RcVuQrMQuv4Ph9DcZakhfwHcZk0lszKnE" : "newer-independent-key");
    delete process.env.MANTIS_BACKUP_TEST_PASS;
  });

  it("restores every profile and its keychain entries on a clean machine", async () => {
    const outPath = join(tmpHome, "bundle.json");
    process.env.MANTIS_BACKUP_TEST_PASS = "diceware-style-test-passphrase";

    await populateState();

    // Backup the populated state.
    const { backupCmd, restoreCmd } = await import("../src/commands/backup.js");
    await backupCmd({
      out: outPath,
      passphraseEnv: "MANTIS_BACKUP_TEST_PASS",
    });

    // Wipe everything as if we were on a brand-new machine.
    await wipeState();
    const config = await import("../src/lib/config.js");
    expect(await config.readConfig()).toBeNull();
    expect(config.getKey("https://primary.example.com")).toBeNull();

    // Restore.
    await restoreCmd(outPath, {
      passphraseEnv: "MANTIS_BACKUP_TEST_PASS",
    });

    // Profiles + their secrets are back, current-profile pointer too.
    const stored = await config.readConfig();
    expect(stored).not.toBeNull();
    expect(stored!.currentProfile).toBe("primary");
    expect(Object.keys(stored!.profiles).sort()).toEqual(["backup", "primary"]);
    expect(stored!.profiles.primary?.cloudflareAccessMode).toBe("service-auth");
    expect(stored!.profiles.primary?.edgeWorkerUrl).toBe(
      "https://primary-edge.workers.dev",
    );

    expect(config.getKey("https://primary.example.com")).toBe(
      "mantis_live_primary_token_aaa",
    );
    expect(config.getKey("https://backup.example.com")).toBe(
      "mantis_live_backup_token_bbb",
    );
    expect(
      config.getCloudflareServiceAuth("https://primary.example.com"),
    ).toEqual({
      client_id: "cf-client-id.access",
      client_secret: "cf-client-secret-shh",
    });

    const edgeKey = await import("../src/lib/edge-key.js");
    expect(edgeKey.getEdgeKey("https://primary-edge.workers.dev")).toBe(
      "MGYWRl0WT3RcVuQrMQuv4Ph9DcZakhfwHcZk0lszKnE",
    );

    delete process.env.MANTIS_BACKUP_TEST_PASS;
  });

  it("--only backs up one profile and leaves the rest behind on restore", async () => {
    const outPath = join(tmpHome, "bundle.json");
    process.env.MANTIS_BACKUP_TEST_PASS = "another-passphrase";

    await populateState();

    const { backupCmd, restoreCmd } = await import("../src/commands/backup.js");
    await backupCmd({
      out: outPath,
      profile: "backup",
      passphraseEnv: "MANTIS_BACKUP_TEST_PASS",
    });

    await wipeState();
    await restoreCmd(outPath, {
      passphraseEnv: "MANTIS_BACKUP_TEST_PASS",
    });

    const config = await import("../src/lib/config.js");
    const stored = await config.readConfig();
    expect(stored).not.toBeNull();
    expect(Object.keys(stored!.profiles)).toEqual(["backup"]);
    expect(config.getKey("https://backup.example.com")).toBe(
      "mantis_live_backup_token_bbb",
    );
    // The "primary" profile's secrets were never bundled, so they stay
    // missing on the restored machine.
    expect(config.getKey("https://primary.example.com")).toBeNull();

    delete process.env.MANTIS_BACKUP_TEST_PASS;
  });

  it("skips existing profiles by default; --overwrite replaces them", async () => {
    const outPath = join(tmpHome, "bundle.json");
    process.env.MANTIS_BACKUP_TEST_PASS = "third-passphrase";

    await populateState();
    const { backupCmd, restoreCmd } = await import("../src/commands/backup.js");
    await backupCmd({
      out: outPath,
      passphraseEnv: "MANTIS_BACKUP_TEST_PASS",
    });

    // Don't wipe — simulate restoring onto a machine that already has the
    // same profile name pointing at a *different* server.
    const config = await import("../src/lib/config.js");
    config.setKey("https://primary.example.com", "mantis_live_DIFFERENT_zzz");
    await config.setProfile("primary", {
      baseUrl: "https://primary.example.com",
      keyPrefix: "mantis_live_DIFFER",
    });

    // Default restore (no --overwrite) should skip the existing profile.
    await restoreCmd(outPath, {
      passphraseEnv: "MANTIS_BACKUP_TEST_PASS",
    });
    expect(config.getKey("https://primary.example.com")).toBe(
      "mantis_live_DIFFERENT_zzz",
    );

    // With --overwrite, the bundled value wins.
    await restoreCmd(outPath, {
      overwrite: true,
      passphraseEnv: "MANTIS_BACKUP_TEST_PASS",
    });
    expect(config.getKey("https://primary.example.com")).toBe(
      "mantis_live_primary_token_aaa",
    );

    delete process.env.MANTIS_BACKUP_TEST_PASS;
  });

  it("rejects the bundle on wrong passphrase, leaving the target machine untouched", async () => {
    const outPath = join(tmpHome, "bundle.json");
    process.env.MANTIS_BACKUP_TEST_PASS_RIGHT = "right-pass";
    process.env.MANTIS_BACKUP_TEST_PASS_WRONG = "wrong-pass";

    await populateState();
    const { backupCmd, restoreCmd } = await import("../src/commands/backup.js");
    await backupCmd({
      out: outPath,
      passphraseEnv: "MANTIS_BACKUP_TEST_PASS_RIGHT",
    });

    await wipeState();
    // fail() throws via process.exit; spy on it so we can assert without
    // tearing down the test runner.
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(((_code?: number) => {
        throw new Error("__test_exit__");
      }) as never);
    await expect(
      restoreCmd(outPath, {
        passphraseEnv: "MANTIS_BACKUP_TEST_PASS_WRONG",
      }),
    ).rejects.toThrow("__test_exit__");
    exitSpy.mockRestore();

    // Target machine wasn't touched — config still empty.
    const config = await import("../src/lib/config.js");
    expect(await config.readConfig()).toBeNull();

    delete process.env.MANTIS_BACKUP_TEST_PASS_RIGHT;
    delete process.env.MANTIS_BACKUP_TEST_PASS_WRONG;
  });
});

// ---------------------------------------------------------------------------
// Keychain credentials are stored per server URL and shared by every profile
// for that URL. "Existing things are kept unless --overwrite" therefore has to
// cover the credential, not only the profile name.
// ---------------------------------------------------------------------------

describe("mantis restore never replaces a server's stored credentials without --overwrite", () => {
  const URL_ = "https://shared.example.com";
  const K1 = "mantis_live_OPERATOR_key_on_this_machine";
  const K2 = "mantis_live_BUNDLE_key_from_elsewhere";
  const CF1 = { client_id: "machine.access", client_secret: "machine-secret" };
  const CF2 = { client_id: "bundle.access", client_secret: "bundle-secret" };
  const PASS = "restore-credential-passphrase";

  /** Write a bundle holding the given profiles and return its path. */
  async function bundleWith(
    profiles: Array<Record<string, unknown>>,
  ): Promise<string> {
    const { sealBundle } = await import("../src/lib/backup.js");
    const envelope = await sealBundle(
      {
        $schema: "mantis-backup-v1",
        exportedAt: new Date().toISOString(),
        profiles: profiles as never,
        plugins: [],
      },
      PASS,
    );
    const path = join(tmpHome, "crafted.json");
    await writeFile(path, JSON.stringify(envelope));
    process.env.MANTIS_BACKUP_TEST_PASS = PASS;
    return path;
  }

  /** This machine: profile `prod` for URL_, with its own key and CF token. */
  async function machineWithProd() {
    const config = await import("../src/lib/config.js");
    config.setKey(URL_, K1);
    config.setCloudflareServiceAuth(URL_, CF1);
    await config.setProfile("prod", {
      baseUrl: URL_,
      keyPrefix: K1.slice(0, 18),
      cloudflareAccessMode: "service-auth",
    });
    return config;
  }

  afterEach(() => {
    delete process.env.MANTIS_BACKUP_TEST_PASS;
  });

  it("skips a new-named bundle profile whose server already has different credentials", async () => {
    const config = await machineWithProd();
    const path = await bundleWith([
      { name: "other", baseUrl: URL_, keyPrefix: K2.slice(0, 18), apiKey: K2, cloudflareAccessMode: "service-auth", cloudflareServiceAuth: CF2 },
    ]);
    const { restoreCmd } = await import("../src/commands/backup.js");

    vi.mocked(process.stderr.write).mockClear();
    await restoreCmd(path, { passphraseEnv: "MANTIS_BACKUP_TEST_PASS", skipPlugins: true });

    expect(config.getKey(URL_)).toBe(K1);
    expect(config.getCloudflareServiceAuth(URL_)).toEqual(CF1);
    expect(await config.getProfile("other")).toBeNull();
    const said = vi.mocked(process.stderr.write).mock.calls.join(" ");
    expect(said).toContain("skipped 1 profile(s) whose server already has different credentials");
    expect(said).toContain("other");
    expect(said).toContain("--overwrite");

    // --overwrite is the explicit way to take the bundle's credentials.
    await restoreCmd(path, { passphraseEnv: "MANTIS_BACKUP_TEST_PASS", skipPlugins: true, overwrite: true });
    expect(config.getKey(URL_)).toBe(K2);
    expect(config.getCloudflareServiceAuth(URL_)).toEqual(CF2);
    expect((await config.getProfile("other"))?.baseUrl).toBe(URL_);

    // `prod` still records the old prefix; whoami now says the key changed.
    const { whoamiCmd } = await import("../src/commands/whoami.js");
    vi.mocked(process.stdout.write).mockClear();
    await whoamiCmd({ profile: "prod" });
    const shown = vi.mocked(process.stdout.write).mock.calls.join(" ");
    expect(shown).toContain(K2.slice(0, 18));
    expect(shown).toContain("has been replaced since");
  }, 20_000);

  it("reports the skip in --json output", async () => {
    await machineWithProd();
    const path = await bundleWith([{ name: "other", baseUrl: URL_, apiKey: K2 }]);
    const { restoreCmd } = await import("../src/commands/backup.js");
    const { setJsonMode } = await import("../src/lib/out.js");

    vi.mocked(process.stdout.write).mockClear();
    setJsonMode(true);
    try {
      await restoreCmd(path, { passphraseEnv: "MANTIS_BACKUP_TEST_PASS", skipPlugins: true });
    } finally {
      setJsonMode(false);
    }
    const result = JSON.parse(String(vi.mocked(process.stdout.write).mock.calls[0]![0]));
    expect(result).toMatchObject({ restored: [], skipped: ["other"], skipped_credentials: ["other"] });
  }, 20_000);

  it("still restores a new profile name when the stored credential is the same one", async () => {
    const config = await machineWithProd();
    const path = await bundleWith([{ name: "alias", baseUrl: URL_, keyPrefix: K1.slice(0, 18), apiKey: K1 }]);
    const { restoreCmd } = await import("../src/commands/backup.js");

    await restoreCmd(path, { passphraseEnv: "MANTIS_BACKUP_TEST_PASS", skipPlugins: true });

    expect((await config.getProfile("alias"))?.baseUrl).toBe(URL_);
    expect(config.getKey(URL_)).toBe(K1);
    expect(config.getCloudflareServiceAuth(URL_)).toEqual(CF1);
  }, 20_000);

  it("still restores bundle profiles that share one server onto a clean machine", async () => {
    const path = await bundleWith([
      { name: "one", baseUrl: URL_, apiKey: K2 },
      { name: "two", baseUrl: URL_, apiKey: K2 },
    ]);
    const { restoreCmd } = await import("../src/commands/backup.js");
    await restoreCmd(path, { passphraseEnv: "MANTIS_BACKUP_TEST_PASS", skipPlugins: true });

    const config = await import("../src/lib/config.js");
    expect(Object.keys((await config.readConfig())!.profiles).sort()).toEqual(["one", "two"]);
    expect(config.getKey(URL_)).toBe(K2);
  }, 20_000);
});

// ---------------------------------------------------------------------------
// The bundle holds full API keys behind nothing but a passphrase; the command
// must not call it "safe to commit", and says so when it lands in a checkout.
// ---------------------------------------------------------------------------

describe("mantis backup output-path guidance", () => {
  async function runBackup(outPath: string): Promise<string> {
    process.env.MANTIS_BACKUP_TEST_PASS = "guidance-passphrase";
    await populateState();
    const { backupCmd } = await import("../src/commands/backup.js");
    vi.mocked(process.stderr.write).mockClear();
    try {
      await backupCmd({ out: outPath, passphraseEnv: "MANTIS_BACKUP_TEST_PASS" });
    } finally {
      delete process.env.MANTIS_BACKUP_TEST_PASS;
    }
    return vi.mocked(process.stderr.write).mock.calls.join(" ");
  }

  it("never prints an unqualified 'safe to commit'", async () => {
    const said = await runBackup(join(tmpHome, "plain", "mantis-backup.json"));
    expect(said).not.toMatch(/safe to commit/i);
    expect(said).toContain("keep it private");
    expect(said).toContain("offline");
    expect(said).not.toContain("git work tree");
  }, 20_000);

  it("warns when the bundle is written inside a git work tree", async () => {
    const repo = join(tmpHome, "checkout");
    await mkdir(join(repo, ".git"), { recursive: true });
    const said = await runBackup(join(repo, "cli", "mantis-backup.json"));
    expect(said).toContain("is inside a git work tree");
    expect(said).toContain(".gitignore");
  }, 20_000);

  it("recognizes a worktree or submodule, where .git is a file", async () => {
    const repo = join(tmpHome, "linked");
    await mkdir(repo, { recursive: true });
    await writeFile(join(repo, ".git"), "gitdir: /somewhere/else\n");
    expect(await runBackup(join(repo, "mantis-backup.json"))).toContain("is inside a git work tree");
  }, 20_000);
});
