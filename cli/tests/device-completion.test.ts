import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  install: vi.fn(async () => false),
  client: {
    deviceProfiles: vi.fn(async () => ({ profiles: [{ os: "linux", defaults: ["login"], vectors: [{ slug: "login", label: "shell login", response_kind: "empty", dedupe_window_seconds: 0 }] }] })),
    createKey: vi.fn(async () => ({ id: "key-one", url: "https://mantis.example/c/one" })),
    deviceBundleFiles: vi.fn(async () => ({ files: {}, installScript: "install.sh", uninstallScript: "uninstall.sh" })),
  },
}));
vi.mock("../src/lib/runner.js", () => ({ withClient: async (_opts: unknown, action: (client: unknown) => unknown) => action(mocks.client) }));
vi.mock("../src/lib/device-install.js", () => ({
  applyBundleLocally: mocks.install, assertBundleInstallableHere: vi.fn(),
}));
import { deviceNewCmd } from "../src/commands/device.js";
import { edgeDeviceCmd } from "../src/commands/edge-device.js";

afterEach(() => vi.restoreAllMocks());
describe("device completion feedback", () => {
  it.each(["server", "edge"])("does not call a declined installation armed (%s)", async (surface) => {
    mocks.install.mockResolvedValue(false);
    const errors: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => { errors.push(String(chunk)); return true; });
    const opts = { os: "linux", name: "audit-host", vectors: "login", install: true };
    if (surface === "server") await deviceNewCmd(opts);
    else await edgeDeviceCmd({ ...opts, worker: "https://edge.example.com", webhook: "https://hooks.example.com", key: Buffer.alloc(32, 7).toString("base64url") });
    expect(errors.join("")).not.toContain(" armed");
    expect(errors.join("")).toContain("Installation canceled. Nothing installed");
    expect(errors.join("")).toContain("minted");
  });

  it("calls a completed installation armed", async () => {
    mocks.install.mockResolvedValue(true);
    const errors: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => { errors.push(String(chunk)); return true; });
    await deviceNewCmd({ os: "linux", name: "audit-host", vectors: "login", install: true });
    expect(errors.join("")).toContain(" armed");
    expect(errors.join("")).not.toContain("Nothing installed");
  });
});
