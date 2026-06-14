import { afterEach, describe, expect, it, vi } from "vitest";
import {
  capStoredRequestField,
  clientIpFromHeaders,
  isSecureRequest,
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
