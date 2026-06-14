import { afterEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import { extractIp } from "@/lib/request-info";

function reqWith(headers: Record<string, string>): NextRequest {
  return new Request("http://localhost/c/abc123", { headers }) as unknown as NextRequest;
}

describe("extractIp (X-Forwarded-For spoofing guard)", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("returns null when proxy headers are not trusted", () => {
    vi.stubEnv("TRUST_PROXY_HEADERS", "0");
    expect(extractIp(reqWith({ "x-forwarded-for": "1.2.3.4" }))).toBeNull();
  });

  it("takes the rightmost XFF entry, not the spoofable leftmost", () => {
    vi.stubEnv("TRUST_PROXY_HEADERS", "1");
    // attacker prepends a fake IP; the real peer is appended on the right
    expect(
      extractIp(reqWith({ "x-forwarded-for": "6.6.6.6, 203.0.113.9" })),
    ).toBe("203.0.113.9");
  });

  it("honours TRUST_PROXY_HOPS for multiple front proxies", () => {
    vi.stubEnv("TRUST_PROXY_HEADERS", "1");
    vi.stubEnv("TRUST_PROXY_HOPS", "2");
    expect(
      extractIp(reqWith({ "x-forwarded-for": "6.6.6.6, 203.0.113.9, 10.0.0.1" })),
    ).toBe("203.0.113.9");
  });

  it("prefers cf-connecting-ip as a single trusted value", () => {
    vi.stubEnv("TRUST_PROXY_HEADERS", "1");
    expect(
      extractIp(
        reqWith({
          "cf-connecting-ip": "203.0.113.9",
          "x-forwarded-for": "6.6.6.6, 203.0.113.9",
        }),
      ),
    ).toBe("203.0.113.9");
  });
});
