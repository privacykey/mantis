import { afterEach, describe, expect, it, vi } from "vitest";
import {
  capStoredRequestField,
  clientIpFromHeaders,
  isSecureRequest,
  parseIpLiteral,
  snapshotHeaders,
} from "@/lib/request-info";

describe("clientIpFromHeaders (X-Forwarded-For spoof resistance)", () => {
  afterEach(() => vi.unstubAllEnvs());

  const get = (map: Record<string, string>) => (n: string) => map[n] ?? null;

  it("returns null when proxy headers aren't trusted", () => {
    vi.stubEnv("TRUST_PROXY_HEADERS", "0");
    expect(
      clientIpFromHeaders(get({ "x-forwarded-for": "1.2.3.4" })),
    ).toBeNull();
  });

  it("takes the rightmost (nearest-proxy) XFF entry, not the spoofable leftmost", () => {
    vi.stubEnv("TRUST_PROXY_HEADERS", "1");
    // Attacker forges "6.6.6.6" as the leftmost; the real peer is appended right.
    expect(
      clientIpFromHeaders(get({ "x-forwarded-for": "6.6.6.6, 203.0.113.9" })),
    ).toBe("203.0.113.9");
  });

  it("honours TRUST_PROXY_HOPS for multiple proxy layers", () => {
    vi.stubEnv("TRUST_PROXY_HEADERS", "1");
    vi.stubEnv("TRUST_PROXY_HOPS", "2");
    expect(
      clientIpFromHeaders(
        get({ "x-forwarded-for": "6.6.6.6, 203.0.113.9, 10.0.0.2" }),
      ),
    ).toBe("203.0.113.9");
  });

  it("prefers single-valued trusted headers over XFF", () => {
    vi.stubEnv("TRUST_PROXY_HEADERS", "1");
    expect(
      clientIpFromHeaders(
        get({
          "cf-connecting-ip": "198.51.100.7",
          "x-forwarded-for": "6.6.6.6, 203.0.113.9",
        }),
      ),
    ).toBe("198.51.100.7");
  });

  it("ignores a forged cf-connecting-ip when TRUSTED_IP_HEADER pins x-real-ip", () => {
    vi.stubEnv("TRUST_PROXY_HEADERS", "1");
    vi.stubEnv("TRUSTED_IP_HEADER", "x-real-ip");
    // Behind nginx/Caddy/Traefik the attacker forges cf-connecting-ip; only the
    // proxy-written x-real-ip is authoritative and must win.
    expect(
      clientIpFromHeaders(
        get({
          "cf-connecting-ip": "6.6.6.6",
          "x-real-ip": "203.0.113.9",
        }),
      ),
    ).toBe("203.0.113.9");
  });

  it("returns null when the pinned header is absent, even if others are present", () => {
    vi.stubEnv("TRUST_PROXY_HEADERS", "1");
    vi.stubEnv("TRUSTED_IP_HEADER", "x-real-ip");
    expect(
      clientIpFromHeaders(get({ "cf-connecting-ip": "6.6.6.6" })),
    ).toBeNull();
  });

  it("normalises TRUSTED_IP_HEADER casing/whitespace", () => {
    vi.stubEnv("TRUST_PROXY_HEADERS", "1");
    vi.stubEnv("TRUSTED_IP_HEADER", "  X-Real-IP  ");
    expect(
      clientIpFromHeaders(
        get({ "cf-connecting-ip": "6.6.6.6", "x-real-ip": "203.0.113.9" }),
      ),
    ).toBe("203.0.113.9");
  });

  it("keeps rightmost-hop XFF parsing when pinned to x-forwarded-for", () => {
    vi.stubEnv("TRUST_PROXY_HEADERS", "1");
    vi.stubEnv("TRUSTED_IP_HEADER", "x-forwarded-for");
    expect(
      clientIpFromHeaders(
        get({
          "cf-connecting-ip": "6.6.6.6",
          "x-forwarded-for": "6.6.6.6, 203.0.113.9",
        }),
      ),
    ).toBe("203.0.113.9");
  });

  it("takes the rightmost hop when pinned to a chain header (x-vercel-forwarded-for)", () => {
    vi.stubEnv("TRUST_PROXY_HEADERS", "1");
    vi.stubEnv("TRUSTED_IP_HEADER", "x-vercel-forwarded-for");
    // x-vercel-forwarded-for can arrive comma-joined "client, proxy"; the
    // leftmost is the spoofable client token, so the rightmost hop must win.
    expect(
      clientIpFromHeaders(
        get({ "x-vercel-forwarded-for": "6.6.6.6, 203.0.113.9" }),
      ),
    ).toBe("203.0.113.9");
  });

  it("applies rightmost-hop parsing to x-vercel-forwarded-for even when unpinned", () => {
    vi.stubEnv("TRUST_PROXY_HEADERS", "1");
    // No TRUSTED_IP_HEADER: the default ordered list still treats the Vercel
    // chain header as a chain, not as a single leftmost token.
    expect(
      clientIpFromHeaders(
        get({ "x-vercel-forwarded-for": "6.6.6.6, 203.0.113.9" }),
      ),
    ).toBe("203.0.113.9");
  });

  it("warns once and falls back to the default list for an unknown TRUSTED_IP_HEADER", () => {
    vi.stubEnv("TRUST_PROXY_HEADERS", "1");
    vi.stubEnv("TRUSTED_IP_HEADER", "x-typo-ip");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      // A typo'd header name must NOT silently null out every IP. It is ignored
      // and the legacy ordered list (cf-connecting-ip first) is consulted.
      expect(
        clientIpFromHeaders(
          get({
            "cf-connecting-ip": "198.51.100.7",
            "x-forwarded-for": "6.6.6.6, 203.0.113.9",
          }),
        ),
      ).toBe("198.51.100.7");
      // The fallback applies on every call, but the warning is emitted once.
      expect(
        clientIpFromHeaders(get({ "cf-connecting-ip": "198.51.100.7" })),
      ).toBe("198.51.100.7");
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
});

// Whichever header wins, its value has to be an IP literal. A header the ingress
// does not overwrite is client-controlled, and free text in it must never be
// recorded as the hit's IP or become a limiter key.
describe("clientIpFromHeaders (IP-literal validation)", () => {
  afterEach(() => vi.unstubAllEnvs());

  const get = (map: Record<string, string>) => (n: string) => map[n] ?? null;

  it("skips a non-IP value and falls through to the next header (unpinned)", () => {
    vi.stubEnv("TRUST_PROXY_HEADERS", "1");
    for (const junk of [
      "not-an-ip",
      "<script>alert(1)</script>",
      "unknown",
      "999.1.1.1",
      "1.2.3",
      "1.2.3.4.5",
      "12345::1::2",
      "localhost",
      "203.0.113.9 extra",
    ]) {
      expect(
        clientIpFromHeaders(
          get({
            "cf-connecting-ip": junk,
            "x-real-ip": junk,
            "x-forwarded-for": "6.6.6.6, 203.0.113.9",
          }),
        ),
        junk,
      ).toBe("203.0.113.9");
    }
  });

  it("returns null when no trusted header carries an IP literal", () => {
    vi.stubEnv("TRUST_PROXY_HEADERS", "1");
    expect(
      clientIpFromHeaders(
        get({ "cf-connecting-ip": "evil\tvalue", "x-forwarded-for": "client, proxy" }),
      ),
    ).toBeNull();
  });

  it("returns null for a non-IP value in the pinned header, never another header", () => {
    vi.stubEnv("TRUST_PROXY_HEADERS", "1");
    vi.stubEnv("TRUSTED_IP_HEADER", "x-real-ip");
    expect(
      clientIpFromHeaders(
        get({ "x-real-ip": "garbage", "cf-connecting-ip": "6.6.6.6" }),
      ),
    ).toBeNull();
  });

  it("does not look further left when the trusted XFF hop is not an IP", () => {
    vi.stubEnv("TRUST_PROXY_HEADERS", "1");
    vi.stubEnv("TRUSTED_IP_HEADER", "x-forwarded-for");
    // The rightmost hop is what the proxy wrote; the leftmost is the client's.
    expect(
      clientIpFromHeaders(get({ "x-forwarded-for": "6.6.6.6, unknown" })),
    ).toBeNull();
  });

  it("accepts IPv6 and normalises the decorations proxies add", () => {
    vi.stubEnv("TRUST_PROXY_HEADERS", "1");
    vi.stubEnv("TRUSTED_IP_HEADER", "x-forwarded-for");
    const cases: Array<[string, string]> = [
      ["2001:db8::1", "2001:db8::1"],
      ["::1", "::1"],
      ["::ffff:203.0.113.9", "::ffff:203.0.113.9"],
      ["2001:db8:0:0:0:0:0:1", "2001:db8:0:0:0:0:0:1"],
      ["203.0.113.9:4711", "203.0.113.9"],
      ["[2001:db8::1]:4711", "2001:db8::1"],
      ["[2001:db8::1]", "2001:db8::1"],
    ];
    for (const [value, expected] of cases) {
      expect(clientIpFromHeaders(get({ "x-forwarded-for": value })), value).toBe(
        expected,
      );
    }
  });

  it("parseIpLiteral rejects everything that is not an address", () => {
    for (const bad of [
      "",
      " ",
      "1.2.3.4/24",
      "01.2.3.4",
      "1:2:3:4:5:6:7",
      "1:2:3:4:5:6:7:8:9",
      "::g",
      "[::1",
      "::1]",
      "1.2.3.4:port",
      "fe80::1%bad zone",
      "example.com",
    ]) {
      expect(parseIpLiteral(bad), JSON.stringify(bad)).toBeNull();
    }
    expect(parseIpLiteral(" 198.51.100.7 ")).toBe("198.51.100.7");
    expect(parseIpLiteral("fe80::1%eth0")).toBe("fe80::1%eth0");
    expect(parseIpLiteral("1:2:3:4:5:6:7::")).toBe("1:2:3:4:5:6:7::");
  });
});

// The unpinned ordered fallback is kept for compatibility, but it is only safe
// behind an ingress that overwrites the first header in the list — say so once.
describe("clientIpFromHeaders (unpinned trust warning)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  const get = (map: Record<string, string>) => (n: string) => map[n] ?? null;

  async function freshModule() {
    vi.resetModules();
    return import("@/lib/request-info");
  }

  it("warns once in production when trust is on and no header is pinned", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("TRUST_PROXY_HEADERS", "1");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const mod = await freshModule();

    expect(mod.clientIpFromHeaders(get({ "x-forwarded-for": "203.0.113.9" }))).toBe(
      "203.0.113.9",
    );
    mod.clientIpFromHeaders(get({ "x-forwarded-for": "203.0.113.9" }));

    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0]?.[0]);
    expect(message).toContain("TRUSTED_IP_HEADER");
    expect(message).toContain("x-forwarded-for behind Tailscale");
  });

  it("stays quiet when the header is pinned, or outside production", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("TRUST_PROXY_HEADERS", "1");
    vi.stubEnv("TRUSTED_IP_HEADER", "x-forwarded-for");
    let mod = await freshModule();
    mod.clientIpFromHeaders(get({ "x-forwarded-for": "203.0.113.9" }));

    vi.unstubAllEnvs();
    vi.stubEnv("TRUST_PROXY_HEADERS", "1");
    mod = await freshModule();
    mod.clientIpFromHeaders(get({ "x-forwarded-for": "203.0.113.9" }));

    expect(warn).not.toHaveBeenCalled();
  });
});

describe("isSecureRequest (session cookie Secure scheme detection)", () => {
  afterEach(() => vi.unstubAllEnvs());

  const get = (map: Record<string, string>) => (n: string) => map[n] ?? null;

  it("marks Secure when the forwarded scheme is https", () => {
    expect(isSecureRequest(get({ "x-forwarded-proto": "https" }))).toBe(true);
  });

  it("does not mark Secure when the forwarded scheme is plain http", () => {
    expect(isSecureRequest(get({ "x-forwarded-proto": "http" }))).toBe(false);
  });

  it("does not mark Secure for local dev over http://localhost", () => {
    // No TLS-terminating proxy in front, so no x-forwarded-proto is present.
    expect(isSecureRequest(get({ host: "localhost:3000" }))).toBe(false);
    expect(isSecureRequest(get({ host: "127.0.0.1:3000" }))).toBe(false);
    expect(isSecureRequest(get({}))).toBe(false);
  });

  it("reads the leftmost (client-facing) entry of a forwarded chain", () => {
    // client → outer proxy (https) → inner proxy (http) appends its hop.
    expect(
      isSecureRequest(get({ "x-forwarded-proto": "https, http" })),
    ).toBe(true);
    expect(
      isSecureRequest(get({ "x-forwarded-proto": "http, https" })),
    ).toBe(false);
  });

  it("normalises forwarded-proto casing and whitespace", () => {
    expect(isSecureRequest(get({ "x-forwarded-proto": "  HTTPS " }))).toBe(true);
  });

  it("marks Secure from a bare RFC 7239 Forwarded: proto=https header", () => {
    // A front end (or misconfigured nginx) that emits only the RFC 7239
    // Forwarded header, never X-Forwarded-Proto, still proves HTTPS.
    expect(isSecureRequest(get({ forwarded: "proto=https" }))).toBe(true);
  });

  it("parses proto=https among other Forwarded params, quoted or cased", () => {
    expect(
      isSecureRequest(
        get({ forwarded: "for=192.0.2.60;proto=https;by=203.0.113.43" }),
      ),
    ).toBe(true);
    expect(isSecureRequest(get({ forwarded: 'proto="https"' }))).toBe(true);
    expect(isSecureRequest(get({ forwarded: "For=192.0.2.60;Proto=HTTPS" }))).toBe(
      true,
    );
  });

  it("does not mark Secure for a Forwarded header without https proto", () => {
    expect(isSecureRequest(get({ forwarded: "proto=http" }))).toBe(false);
    expect(isSecureRequest(get({ forwarded: "for=192.0.2.60" }))).toBe(false);
  });

  it("reads the leftmost element of a multi-hop Forwarded header", () => {
    // First (outermost) element is the client-facing hop, mirroring XFP.
    expect(
      isSecureRequest(get({ forwarded: "proto=https, proto=http" })),
    ).toBe(true);
    expect(
      isSecureRequest(get({ forwarded: "proto=http, proto=https" })),
    ).toBe(false);
  });

  it("forces Secure when FORCE_SECURE_COOKIES=1 with no scheme headers", () => {
    vi.stubEnv("FORCE_SECURE_COOKIES", "1");
    expect(isSecureRequest(get({}))).toBe(true);
  });

  it("forces Secure OFF when FORCE_SECURE_COOKIES=0 despite https headers", () => {
    vi.stubEnv("FORCE_SECURE_COOKIES", "0");
    expect(isSecureRequest(get({ "x-forwarded-proto": "https" }))).toBe(false);
    expect(isSecureRequest(get({ forwarded: "proto=https" }))).toBe(false);
  });

  it("falls back to header auto-detection when FORCE_SECURE_COOKIES is unset", () => {
    expect(isSecureRequest(get({ "x-forwarded-proto": "https" }))).toBe(true);
    expect(isSecureRequest(get({}))).toBe(false);
  });
});

describe("request info capture caps", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("preserves ordinary request fields", () => {
    expect(capStoredRequestField("curl/8.0")).toBe("curl/8.0");
    expect(capStoredRequestField(null)).toBeNull();
  });

  it("marks oversized request fields when capped", () => {
    vi.stubEnv("MANTIS_MAX_STORED_REQUEST_FIELD_CHARS", "256");
    const capped = capStoredRequestField("a".repeat(300));
    expect(capped).toHaveLength(256);
    expect(capped?.endsWith("[mantis-truncated]")).toBe(true);
  });

  it("caps stored header snapshots and records a truncation marker", () => {
    vi.stubEnv("MANTIS_MAX_STORED_REQUEST_FIELD_CHARS", "256");
    vi.stubEnv("MANTIS_MAX_STORED_HEADER_SNAPSHOT_CHARS", "1024");

    const req = new Request("http://localhost/c/abc123", {
      headers: {
        "User-Agent": "mantis-test",
        "X-Mantis-Source": "shell",
        "X-Mantis-Host": "h".repeat(2000),
      },
    });

    const headers = snapshotHeaders(req as never);
    expect(headers["user-agent"]).toBe("mantis-test");
    expect(headers["x-mantis-source"]).toBe("shell");
    expect(headers["x-mantis-host"]).toHaveLength(256);
    expect(headers["x-mantis-capture-truncated"]).toBe("headers");
  });
});
