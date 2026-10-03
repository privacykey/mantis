import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

// external_id is first-writer-wins: a key somebody else created for this
// machine's identity comes back as `reused`, with their settings. Arming the
// machine with it would install an alarm that may never ring.
describe("a reused key is only adopted when it is ours and live", () => {
  const live = { id: "existing-key", url: "https://mantis.example.com/c/existing", disabled: false, disabled_at: null, expires_at: null };
  let paths: string[];
  function serve(reused: Record<string, unknown>): void {
    paths = [];
    vi.mocked(applyBundleLocally).mockClear();
    vi.stubGlobal("fetch", async (url: URL) => {
      paths.push(url.pathname);
      if (url.pathname === "/api/device-profiles") return Response.json({ profiles: [{ ...profile, defaults: ["login"] }] });
      if (url.pathname === "/api/keys/device-bundle") return Response.json({ files: {}, installScript: "install.sh", uninstallScript: "uninstall.sh" });
      return Response.json({ ...live, ...reused }, { status: 200 });
    });
  }

  it.each([
    ["created by another API key", { reused: true, created_by_caller: false }, "different API key"],
    ["disabled", { reused: true, created_by_caller: true, disabled: true, disabled_at: "2026-09-01T00:00:00Z" }, "is disabled"],
    ["set to expire", { reused: true, created_by_caller: true, expires_at: "2000-01-01T00:00:00Z" }, "expire"],
    ["expiring, on a server without created_by_caller", { reused: true, expires_at: "2030-01-01T00:00:00Z" }, "expire"],
  ])("refuses one that is %s, before any bundle or install step", async (_name, reused, reason) => {
    serve(reused);
    await expect(deviceNewCmd({ ...auth, install: true, yes: true, bundle: "/nonexistent/never-written.zip" })).rejects.toThrow("exit 1");
    const error = errors.join("");
    expect(error).toContain("mantis:device:linux:web01:login already belongs to key existing-key");
    expect(error).toContain(reason);
    expect(error).toContain("Refusing to arm");
    expect(error).toContain("Nothing was bundled or installed");
    // Re-running would adopt the same key again, so no resume command.
    expect(error).not.toContain("Resume with");
    expect(paths).not.toContain("/api/keys/device-bundle");
    expect(applyBundleLocally).not.toHaveBeenCalled();
  });

  it.each([
    ["ours and live", { reused: true, created_by_caller: true }],
    ["live on an older server that does not report the creator", { reused: true }],
    ["freshly created", {}],
  ])("adopts one that is %s", async (_name, reused) => {
    serve(reused);
    await deviceNewCmd({ ...auth, install: true, yes: true });
    expect(applyBundleLocally).toHaveBeenCalledTimes(1);
    expect(errors.join("")).toContain("armed");
  });
});
