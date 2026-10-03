import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

// What happened, in order: keychain writes/deletes and stderr lines.
const events = vi.hoisted(() => [] as string[]);
const keychain = vi.hoisted(() => new Map<string, string>());
vi.mock("@napi-rs/keyring", () => ({ Entry: class {
  id: string;
  constructor(service: string, account: string) { this.id = `${service}:${account}`; }
  setPassword(value: string) { events.push(`set ${this.id}`); keychain.set(this.id, value); }
  getPassword() { return keychain.get(this.id) ?? null; }
  deletePassword() { events.push(`delete ${this.id}`); keychain.delete(this.id); }
} }));
vi.mock("../src/lib/keychain-notice.js", () => ({ maybeEmitKeychainNotice: () => {} }));
// No cloudflared on the test machine, and none is ever launched.
const cloudflared = vi.hoisted(() => ({
  cloudflaredInstalled: vi.fn(() => false),
  cloudflareInteractiveLogin: vi.fn(),
  cloudflareInteractiveLogout: vi.fn(),
  fetchCloudflareJwt: vi.fn(() => "jwt"),
}));
vi.mock("../src/lib/cloudflare.js", () => ({
  ...cloudflared,
  CloudflareAuthError: class extends Error {},
}));

const LAB = "http://lab.lan:3000";
const PROD = "https://mantis.prod.example";
const CF = "mantis-cli-cf";

let dir: string;
const saved = { ...process.env };

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mantis-cf-profile-"));
  process.env.XDG_CONFIG_HOME = dir;
  delete process.env.MANTIS_PROFILE;
  delete process.env.MANTIS_BASE_URL;
  keychain.clear();
  events.length = 0;
  cloudflared.cloudflaredInstalled.mockReturnValue(false);
  vi.resetModules();
  vi.spyOn(process.stderr, "write").mockImplementation((x) => { events.push(`stderr ${String(x)}`); return true; });
  vi.spyOn(process.stdout, "write").mockImplementation((x) => { events.push(`stdout ${String(x)}`); return true; });
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => { throw new Error(`exit ${code}`); }) as never);
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  process.env = { ...saved };
  await rm(dir, { recursive: true, force: true });
});

/** Two profiles; `lab` is the current one. */
async function twoProfiles() {
  const cfg = await import("../src/lib/config.js");
  await cfg.setProfile("lab", { baseUrl: LAB });
  await cfg.setProfile("prod", { baseUrl: PROD });
  await cfg.useProfile("lab");
  events.length = 0;
  return cfg;
}
const serviceAuth = { clientId: "prod-svc.access", clientSecret: "PROD-CF-SECRET-dummy" };

it("set-service-auth --profile stores the credential for the named profile's server only", async () => {
  const cfg = await twoProfiles();
  const { cloudflareSetServiceAuthCmd } = await import("../src/commands/cloudflare.js");

  await cloudflareSetServiceAuthCmd({ ...serviceAuth, profile: "prod" });

  expect(keychain.get(`${CF}:${PROD}`)).toContain("PROD-CF-SECRET-dummy");
  expect(keychain.has(`${CF}:${LAB}`)).toBe(false);
  expect((await cfg.getProfile("prod"))?.cloudflareAccessMode).toBe("service-auth");
  expect((await cfg.getProfile("lab"))?.cloudflareAccessMode).toBeUndefined();
  // The current profile's requests carry no Access headers; prod's do.
  cfg.setKey(LAB, "mantis_live_lab");
  cfg.setKey(PROD, "mantis_live_prod");
  expect((await cfg.resolveAuth({})).cloudflare).toBeUndefined();
  expect((await cfg.resolveAuth({ profile: "prod" })).cloudflare).toMatchObject({ mode: "service-auth", clientId: "prod-svc.access" });
});

it("names the target profile and base URL before the secret is stored", async () => {
  await twoProfiles();
  const { cloudflareSetServiceAuthCmd } = await import("../src/commands/cloudflare.js");

  await cloudflareSetServiceAuthCmd({ ...serviceAuth, profile: "prod" });

  const announced = events.findIndex((e) => e.startsWith("stderr") && e.includes("prod") && e.includes(PROD));
  const stored = events.findIndex((e) => e === `set ${CF}:${PROD}`);
  expect(announced).toBeGreaterThanOrEqual(0);
  expect(stored).toBeGreaterThan(announced);
});

it("uses the current profile when --profile is not given", async () => {
  await twoProfiles();
  const { cloudflareSetServiceAuthCmd } = await import("../src/commands/cloudflare.js");
  await cloudflareSetServiceAuthCmd(serviceAuth);
  expect(keychain.has(`${CF}:${LAB}`)).toBe(true);
  expect(keychain.has(`${CF}:${PROD}`)).toBe(false);
});

it.each(["set-service-auth", "login", "logout", "status"])("%s fails for a named profile that does not exist, changing nothing", async (sub) => {
  const cfg = await twoProfiles();
  cfg.setCloudflareServiceAuth(LAB, { client_id: "lab.access", client_secret: "lab-secret" });
  await cfg.patchProfile("lab", { cloudflareAccessMode: "service-auth" });
  events.length = 0;
  const cmd = await import("../src/commands/cloudflare.js");
  const run = {
    "set-service-auth": () => cmd.cloudflareSetServiceAuthCmd({ ...serviceAuth, profile: "nope" }),
    login: () => cmd.cloudflareLoginCmd({ app: PROD, profile: "nope" }),
    logout: () => cmd.cloudflareLogoutCmd({ profile: "nope" }),
    status: () => cmd.cloudflareStatusCmd({ profile: "nope" }),
  }[sub]!;

  await expect(run()).rejects.toThrow("exit 1");

  expect(events.join("")).toContain("profile 'nope' not found");
  expect(events.some((e) => e.startsWith("set ") || e.startsWith("delete "))).toBe(false);
  expect(keychain.get(`${CF}:${LAB}`)).toContain("lab-secret");
  expect((await cfg.getProfile("lab"))?.cloudflareAccessMode).toBe("service-auth");
});

it("refuses --base-url instead of silently configuring the current profile", async () => {
  await twoProfiles();
  const { cloudflareSetServiceAuthCmd } = await import("../src/commands/cloudflare.js");
  await expect(cloudflareSetServiceAuthCmd({ ...serviceAuth, baseUrl: PROD })).rejects.toThrow("exit 3");
  expect(events.join("")).toContain("--base-url");
  expect(keychain.size).toBe(0);
});

it("login --profile binds the Access app to the named profile", async () => {
  const cfg = await twoProfiles();
  cloudflared.cloudflaredInstalled.mockReturnValue(true);
  const { cloudflareLoginCmd } = await import("../src/commands/cloudflare.js");

  await cloudflareLoginCmd({ app: PROD, profile: "prod" });

  expect(cloudflared.cloudflareInteractiveLogin).toHaveBeenCalledWith(PROD);
  expect(await cfg.getProfile("prod")).toMatchObject({ cloudflareAccessMode: "sso", cloudflareAccessAppUrl: PROD });
  expect((await cfg.getProfile("lab"))?.cloudflareAccessMode).toBeUndefined();
});

it("logout --profile clears the named profile and leaves the current one alone", async () => {
  const cfg = await twoProfiles();
  for (const [name, url] of [["lab", LAB], ["prod", PROD]] as const) {
    cfg.setCloudflareServiceAuth(url, { client_id: `${name}.access`, client_secret: `${name}-secret` });
    await cfg.patchProfile(name, { cloudflareAccessMode: "service-auth" });
  }
  const { cloudflareLogoutCmd } = await import("../src/commands/cloudflare.js");

  await cloudflareLogoutCmd({ profile: "prod" });

  expect(keychain.has(`${CF}:${PROD}`)).toBe(false);
  expect((await cfg.getProfile("prod"))?.cloudflareAccessMode).toBeUndefined();
  expect(keychain.get(`${CF}:${LAB}`)).toContain("lab-secret");
  expect((await cfg.getProfile("lab"))?.cloudflareAccessMode).toBe("service-auth");
});

it("status --profile reports the named profile and its server", async () => {
  await twoProfiles();
  const { cloudflareStatusCmd } = await import("../src/commands/cloudflare.js");
  await cloudflareStatusCmd({ profile: "prod" });
  const out = events.filter((e) => e.startsWith("stdout")).join("");
  expect(out).toContain("prod");
  expect(out).toContain(PROD);
  expect(out).not.toContain(LAB);
});

it("logout stays a quiet no-op when nobody is logged in", async () => {
  const { cloudflareLogoutCmd } = await import("../src/commands/cloudflare.js");
  await expect(cloudflareLogoutCmd()).resolves.toBeUndefined();
  expect(events).toEqual([]);
});
