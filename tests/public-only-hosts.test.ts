import { describe, expect, it } from "vitest";
import {
  isAllowedPublicPath,
  isPublicOnlyHost,
  normalizeHost,
  publicOnlyDecision,
} from "@/lib/public-only-hosts";

describe("public-only host guard", () => {
  it("normalizes hosts from headers, domains, and pasted URLs", () => {
    expect(normalizeHost("MANTIS-PUBLIC.example.ts.net:443")).toBe(
      "mantis-public.example.ts.net",
    );
    expect(normalizeHost("https://mantis-public.example.ts.net/path")).toBe(
      "mantis-public.example.ts.net",
    );
    expect(normalizeHost("mantis-public.example.ts.net.")).toBe(
      "mantis-public.example.ts.net",
    );
  });

  it("matches only configured public-only hosts", () => {
    const hosts = "mantis-public.example.ts.net, https://hooks.example.ts.net";
    expect(isPublicOnlyHost("mantis-public.example.ts.net", hosts)).toBe(true);
    expect(isPublicOnlyHost("hooks.example.ts.net:443", hosts)).toBe(true);
    expect(isPublicOnlyHost("mantis-private.example.ts.net", hosts)).toBe(false);
  });

  it("allows public trigger, status, and wallet endpoints", () => {
    expect(isAllowedPublicPath("/c/abc")).toBe(true);
    expect(isAllowedPublicPath("/status/abc")).toBe(true);
    expect(isAllowedPublicPath("/api/wallet/v1/log")).toBe(true);
  });

  it("blocks dashboard and management API paths on public-only hosts", () => {
    const configuredHosts = "mantis-public.example.ts.net";
    for (const pathname of ["/", "/login", "/keys", "/api/keys", "/api/api-keys"]) {
      expect(
        publicOnlyDecision({
          host: "mantis-public.example.ts.net",
          pathname,
          configuredHosts,
        }),
      ).toEqual({ publicOnly: true, allowed: false });
    }
  });

  it("does not restrict private hosts", () => {
    expect(
      publicOnlyDecision({
        host: "mantis-private.example.ts.net",
        pathname: "/api/keys",
        configuredHosts: "mantis-public.example.ts.net",
        configuredDashboardHosts: "mantis-private.example.ts.net",
      }),
    ).toEqual({ publicOnly: false, allowed: true });
  });

  it("fails closed for unknown hosts when public-only hosts are configured", () => {
    expect(
      publicOnlyDecision({
        host: "spoofed.example.ts.net",
        pathname: "/api/keys",
        configuredHosts: "mantis-public.example.ts.net",
      }),
    ).toEqual({ publicOnly: true, allowed: false });
  });

  it("supports explicit public health and inbox opt-ins", () => {
    expect(isAllowedPublicPath("/api/health")).toBe(false);
    expect(isAllowedPublicPath("/api/health", { allowHealth: true })).toBe(true);
    expect(isAllowedPublicPath("/inbox/test")).toBe(false);
    expect(isAllowedPublicPath("/inbox/test", { allowInbox: true })).toBe(true);
    expect(isAllowedPublicPath("/api/inbox", { allowInbox: true })).toBe(true);
  });
});
