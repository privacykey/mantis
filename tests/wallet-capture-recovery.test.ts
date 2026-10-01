import { expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const capture = vi.hoisted(() => ({ record: vi.fn().mockResolvedValue(false), generate: vi.fn() }));
vi.mock("@/db/client", () => ({ db: { delete: () => ({ where: async () => [] }) } }));
vi.mock("@/lib/log", () => ({ log: { warn() {} } }));
vi.mock("@/lib/installers/apple-wallet", () => ({ generateApplePass: capture.generate }));
vi.mock("@/lib/installers/wallet-hit", () => ({
  authenticateWalletRequest: async () => ({ ok: true, key: { id: "key", publicId: "serial", memo: "wallet" } }),
  recordWalletHit: capture.record,
}));
import { POST, DELETE } from "@/app/api/wallet/v1/devices/[deviceId]/registrations/[passTypeId]/[serial]/route";
import { GET } from "@/app/api/wallet/v1/passes/[passTypeId]/[serial]/route";

it.each(["install", "uninstall", "fetch"])("returns a retryable failure when %s capture could not commit", async (event) => {
  const params = { params: Promise.resolve({ deviceId: "phone", passTypeId: "pass.test", serial: "serial" }) };
  const request = new NextRequest("http://localhost/wallet", { method: event === "install" ? "POST" : event === "uninstall" ? "DELETE" : "GET" });
  const response = await (event === "install" ? POST : event === "uninstall" ? DELETE : GET)(request, params);
  expect(response.status).toBe(503);
  expect(response.headers.get("retry-after")).toBe("1");
  expect(capture.generate).not.toHaveBeenCalled();
});
