import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { isPrivateAddress, assertSafeWebhookUrl, UnsafeUrlError } from "@/lib/ssrf";

const lookupMock = vi.hoisted(() => vi.fn());

vi.mock("node:dns/promises", () => ({
  lookup: lookupMock,
}));

describe("isPrivateAddress", () => {
  it.each([
    ["10.0.0.1", true],
    ["10.255.255.255", true],
    ["172.16.0.1", true],
    ["172.31.255.255", true],
    ["172.32.0.1", false], // outside RFC1918
    ["192.168.1.1", true],
    ["127.0.0.1", true],
    ["169.254.169.254", true], // AWS/GCP/Azure metadata
    ["0.0.0.0", true],
    ["100.64.0.1", true], // CGNAT
    ["8.8.8.8", false],
    ["1.1.1.1", false],
    ["224.0.0.1", true], // multicast
    ["::1", true],
    ["::", true],
    ["fe80::1", true],
    ["fc00::1", true],
    ["fd00::1", true],
    ["ff00::1", true],
    ["2606:4700:4700::1111", false], // Cloudflare DNS, public
    ["::ffff:127.0.0.1", true], // IPv4-mapped loopback
    ["::ffff:8.8.8.8", false],
    ["", false],
    ["not-an-ip", false],
  ])("isPrivateAddress(%j) → %j", (addr, expected) => {
    expect(isPrivateAddress(addr)).toBe(expected);
  });
});

describe("assertSafeWebhookUrl", () => {
  const origAllow = process.env.ALLOW_PRIVATE_WEBHOOKS;
  beforeEach(() => {
    delete process.env.ALLOW_PRIVATE_WEBHOOKS;
    lookupMock.mockReset();
    lookupMock.mockImplementation(async (host: string) => {
      if (host === "example.com") return [{ address: "93.184.216.34", family: 4 }];
      if (host === "localhost") {
        return [
          { address: "127.0.0.1", family: 4 },
          { address: "::1", family: 6 },
        ];
      }
      return [];
    });
  });
  afterEach(() => {
    if (origAllow === undefined) delete process.env.ALLOW_PRIVATE_WEBHOOKS;
    else process.env.ALLOW_PRIVATE_WEBHOOKS = origAllow;
  });

  it("accepts a public hostname", async () => {
    await expect(assertSafeWebhookUrl("https://example.com/hook")).resolves.toBeUndefined();
  });

  it("rejects file:// scheme", async () => {
    await expect(assertSafeWebhookUrl("file:///etc/passwd")).rejects.toThrow(UnsafeUrlError);
  });

  it("rejects javascript: scheme", async () => {
    await expect(assertSafeWebhookUrl("javascript:alert(1)")).rejects.toThrow(UnsafeUrlError);
  });

  it("rejects literal AWS metadata IP", async () => {
    await expect(assertSafeWebhookUrl("http://169.254.169.254/latest/meta-data/")).rejects.toThrow(/private address/);
  });

  it("rejects loopback by IP", async () => {
    await expect(assertSafeWebhookUrl("http://127.0.0.1:5432/")).rejects.toThrow(/private address/);
  });

  it("rejects 'localhost' (DNS-resolves to 127.0.0.1 / ::1)", async () => {
    await expect(assertSafeWebhookUrl("http://localhost/hook")).rejects.toThrow();
  });

  it("allows private addresses when ALLOW_PRIVATE_WEBHOOKS=1", async () => {
    process.env.ALLOW_PRIVATE_WEBHOOKS = "1";
    await expect(assertSafeWebhookUrl("http://10.0.0.1:8080/hook")).resolves.toBeUndefined();
    await expect(assertSafeWebhookUrl("http://127.0.0.1/hook")).resolves.toBeUndefined();
  });

  it("rejects malformed URLs", async () => {
    await expect(assertSafeWebhookUrl("not a url")).rejects.toThrow(UnsafeUrlError);
  });
});
