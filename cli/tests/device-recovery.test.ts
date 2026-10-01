import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("../src/lib/device-install.js", () => ({ assertBundleInstallableHere: vi.fn(), applyBundleLocally: vi.fn(async () => true) }));
import { deviceNewCmd } from "../src/commands/device.js";
import { applyBundleLocally } from "../src/lib/device-install.js";
const profile = { os: "linux", label: "Linux", defaults: ["login", "boot"], vectors: ["login", "boot"].map((slug) => ({ slug, label: slug, response_kind: "empty", dedupe_window_seconds: 0 })) };
const auth = { baseUrl: "https://mantis.example.com", key: "fake", retries: "0", os: "linux", name: "web01" };
let errors: string[];
beforeEach(() => {
  errors = [];
  vi.spyOn(process.stderr, "write").mockImplementation((x) => { errors.push(String(x)); return true; });
  vi.spyOn(process, "exit").mockImplementation((code) => { throw new Error(`exit ${code}`); });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("reports confirmed IDs and an idempotent rerun command after partial device creation", async () => {
  let posts = 0;
  vi.stubGlobal("fetch", async (url: URL) => {
    if (url.pathname === "/api/device-profiles") return Response.json({ profiles: [profile] });
    posts += 1;
    return posts === 1 ? Response.json({ id: "confirmed-key", url: "https://mantis.example.com/c/confirmed" }, { status: 201 }) : Response.json({ error: "database unavailable" }, { status: 503 });
  });
  await expect(deviceNewCmd(auth)).rejects.toThrow("exit 1");
  const error = errors.join("");
  expect(error).toContain("1 key(s) confirmed");
  expect(error).toContain("confirmed-key https://mantis.example.com/c/confirmed");
  expect(error).toContain("--base-url 'https://mantis.example.com' device new --name 'web01' --os linux --vectors 'login,boot'");
  expect(error).toContain("reuse existing keys");
  expect(error).not.toContain("armed");
});

it("retains minted IDs when a local installer fails", async () => {
  vi.mocked(applyBundleLocally).mockRejectedValueOnce(new Error("installer exited with code 1; files staged at /tmp/device"));
  vi.stubGlobal("fetch", async (url: URL) => {
    if (url.pathname === "/api/device-profiles") return Response.json({ profiles: [{ ...profile, defaults: ["login"] }] });
    if (url.pathname === "/api/keys/device-bundle") return Response.json({ files: {}, installScript: "install.sh", uninstallScript: "uninstall.sh" });
    return Response.json({ id: "confirmed-key", url: "https://mantis.example.com/c/confirmed" }, { status: 201 });
  });
  await expect(deviceNewCmd({ ...auth, install: true, yes: true })).rejects.toThrow("exit 1");
  expect(errors.join("")).toContain("confirmed-key");
  expect(errors.join("")).toContain("--install");
  expect(errors.join("")).toContain("/tmp/device");
});
