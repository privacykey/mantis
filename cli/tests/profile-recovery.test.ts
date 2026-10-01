import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const keychain = vi.hoisted(() => new Map<string, string>());
vi.mock("@napi-rs/keyring", () => ({ Entry: class {
  id: string;
  constructor(service: string, account: string) { this.id = `${service}:${account}`; }
  setPassword(value: string) { keychain.set(this.id, value); }
  getPassword() { return keychain.get(this.id) ?? null; }
  deletePassword() { keychain.delete(this.id); }
} }));
vi.mock("../src/lib/keychain-notice.js", () => ({ maybeEmitKeychainNotice: () => {} }));
let dir: string;
const saved = { ...process.env };
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mantis-profile-recovery-"));
  process.env.XDG_CONFIG_HOME = dir;
  delete process.env.MANTIS_API_KEY;
  delete process.env.MANTIS_PROFILE;
  delete process.env.MANTIS_BASE_URL;
  keychain.clear();
  vi.resetModules();
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); process.env = { ...saved }; await rm(dir, { recursive: true, force: true }); });
const baseUrl = "https://mantis.example.com";
async function sharedProfiles() {
  const cfg = await import("../src/lib/config.js");
  cfg.setKey(baseUrl, "mantis_live_shared");
  cfg.setCloudflareServiceAuth(baseUrl, { client_id: "client.access", client_secret: "fake-secret" });
  await cfg.setProfile("prod", { baseUrl, cloudflareAccessMode: "service-auth" });
  await cfg.setProfile("alternate", { baseUrl });
  return cfg;
}

it.each(["remove", "logout"])("%s keeps shared credentials until the last profile is removed", async (action) => {
  const cfg = await sharedProfiles();
  if (action === "remove") {
    const { profileRmCmd } = await import("../src/commands/profile.js");
    await profileRmCmd("alternate", { yes: true });
  } else {
    const { logoutCmd } = await import("../src/commands/logout.js");
    await logoutCmd({ profile: "alternate" });
  }
  expect(await cfg.resolveAuth({ profile: "prod" })).toMatchObject({ key: "mantis_live_shared", cloudflare: { mode: "service-auth" } });
  await cfg.removeProfile("prod");
  expect(cfg.getKey(baseUrl)).toBeNull();
  expect(cfg.getCloudflareServiceAuth(baseUrl)).toBeNull();
});

it("reauthenticates through the profile's configured Access service credentials", async () => {
  const cfg = await sharedProfiles();
  const { loginCmd } = await import("../src/commands/login.js");
  const requests: RequestInit[] = [];
  vi.stubGlobal("fetch", async (_url: URL, init: RequestInit) => {
    requests.push(init);
    return Response.json({ data: [], next_cursor: null });
  });
  await loginCmd({ profile: "prod", url: baseUrl, key: "mantis_live_replacement" });
  expect(requests[0]?.headers).toMatchObject({ Authorization: "Bearer mantis_live_replacement", "CF-Access-Client-Id": "client.access", "CF-Access-Client-Secret": "fake-secret" });
  expect(cfg.getKey(baseUrl)).toBe("mantis_live_replacement");
});

it("uses configured Access credentials for monitor status on the private API host", async () => {
  const cfg = await sharedProfiles();
  const { MantisClient } = await import("../src/lib/api.js");
  const requests: RequestInit[] = [];
  vi.stubGlobal("fetch", async (_url: URL, init: RequestInit) => {
    requests.push(init);
    return Response.json({ status: "ok" });
  });
  const client = new MantisClient(await cfg.resolveAuth({ profile: "prod" }));
  expect(await client.fetchStatus("pub")).toEqual({ status: "ok" });
  expect(requests[0]?.headers).toMatchObject({ "CF-Access-Client-Id": "client.access", "CF-Access-Client-Secret": "fake-secret" });
});

it("does not forward old Access credentials or metadata when login changes the server", async () => {
  const cfg = await import("../src/lib/config.js");
  const { loginCmd } = await import("../src/commands/login.js");
  await cfg.setProfile("prod", { baseUrl, cloudflareAccessMode: "sso", cloudflareAccessAppUrl: baseUrl, edgeWorkerUrl: "https://edge.example.com" });
  const requests: RequestInit[] = [];
  vi.stubGlobal("fetch", async (_url: URL, init: RequestInit) => { requests.push(init); return Response.json({ data: [], next_cursor: null }); });
  await loginCmd({ profile: "prod", url: "https://new-server.example.com", key: "mantis_live_replacement" });
  expect(requests[0]?.headers).toEqual({ Authorization: "Bearer mantis_live_replacement" });
  expect(await cfg.getProfile("prod")).toMatchObject({ baseUrl: "https://new-server.example.com", edgeWorkerUrl: "https://edge.example.com" });
  expect((await cfg.getProfile("prod"))?.cloudflareAccessMode).toBeUndefined();
  expect((await cfg.getProfile("prod"))?.cloudflareAccessAppUrl).toBeUndefined();
});
