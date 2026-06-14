import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import {
  isPrivateAddress,
  assertSafeWebhookUrl,
  safeLookup,
  UnsafeUrlError,
} from "@/lib/ssrf";

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
    ["192.88.99.1", true], // 6to4 relay anycast
    ["192.88.98.1", false], // adjacent /24, public
    ["198.18.0.1", true], // benchmarking 198.18.0.0/15
    ["198.19.255.255", true], // benchmarking, upper end
    ["198.20.0.1", false], // outside benchmarking range
    ["::1", true],
    ["::", true],
    ["fe80::1", true],
    ["fc00::1", true],
    ["fd00::1", true],
    ["ff00::1", true],
    ["2606:4700:4700::1111", false], // Cloudflare DNS, public
    ["::ffff:127.0.0.1", true], // IPv4-mapped loopback (dotted)
    ["::ffff:8.8.8.8", false],
    ["::ffff:a9fe:a9fe", true], // hex IPv4-mapped metadata — was a bypass
    ["::ffff:7f00:1", true], // hex IPv4-mapped loopback — was a bypass
    ["::ffff:0a00:0001", true], // hex IPv4-mapped 10.0.0.1 — was a bypass
    ["64:ff9b::a9fe:a9fe", true], // NAT64 well-known → metadata
    ["64:ff9b::8.8.8.8", false], // NAT64 → public address
    ["2002:7f00:1::", true], // 6to4 → loopback
    ["2002:0808:0808::", false], // 6to4 → public 8.8.8.8
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

describe("safeLookup (DNS-rebinding connect guard)", () => {
  const origAllow = process.env.ALLOW_PRIVATE_WEBHOOKS;
  beforeEach(() => {
    delete process.env.ALLOW_PRIVATE_WEBHOOKS;
    lookupMock.mockReset();
  });
  afterEach(() => {
    if (origAllow === undefined) delete process.env.ALLOW_PRIVATE_WEBHOOKS;
    else process.env.ALLOW_PRIVATE_WEBHOOKS = origAllow;
  });

  // Promisified wrapper around the dns.lookup-style callback API.
  function run(
    host: string,
    options: { all?: boolean; family?: number } = {},
  ): Promise<{ address: string | { address: string; family: number }[]; family?: number }> {
    return new Promise((resolve, reject) => {
      safeLookup(host, options, (err, address, family) => {
        if (err) reject(err);
        else resolve({ address, family });
      });
    });
  }

  it("returns the validated address for a public host", async () => {
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const res = await run("example.com");
    expect(res.address).toBe("93.184.216.34");
    expect(res.family).toBe(4);
  });

  it("rejects when the host resolves to a private address (rebinding)", async () => {
    // The pre-flight saw a public IP; by connect time the record flipped to
    // metadata. safeLookup must catch it at the point of connection.
    lookupMock.mockResolvedValue([{ address: "169.254.169.254", family: 4 }]);
    await expect(run("rebind.evil")).rejects.toThrow(/private address/);
  });

  it("rejects if ANY resolved address is private (mixed record set)", async () => {
    lookupMock.mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
      { address: "10.0.0.5", family: 4 },
    ]);
    await expect(run("mixed.evil")).rejects.toThrow(/private address/);
  });

  it("returns all validated addresses when options.all is set", async () => {
    lookupMock.mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
      { address: "2606:4700:4700::1111", family: 6 },
    ]);
    const res = await run("example.com", { all: true });
    expect(Array.isArray(res.address)).toBe(true);
    expect(res.address).toHaveLength(2);
  });

  it("filters to the requested address family", async () => {
    lookupMock.mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
      { address: "2606:4700:4700::1111", family: 6 },
    ]);
    const res = await run("example.com", { family: 6 });
    expect(res.address).toBe("2606:4700:4700::1111");
    expect(res.family).toBe(6);
  });

  it("allows private addresses when ALLOW_PRIVATE_WEBHOOKS=1", async () => {
    process.env.ALLOW_PRIVATE_WEBHOOKS = "1";
    lookupMock.mockResolvedValue([{ address: "10.0.0.1", family: 4 }]);
    const res = await run("internal.lan");
    expect(res.address).toBe("10.0.0.1");
  });

  it("rejects when the host does not resolve", async () => {
    lookupMock.mockResolvedValue([]);
    await expect(run("nxdomain.invalid")).rejects.toThrow(/did not resolve/);
  });
});
