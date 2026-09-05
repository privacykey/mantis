import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { config, proxy } from "@/proxy";
import { publicPathRewrite } from "@/lib/public-path";

// Regression guard: the host-based public/dashboard split is only enforced if
// proxy.ts is wired as the Next.js proxy entrypoint from this magic filename.
// If proxy.ts is ever deleted/renamed or stops exporting `proxy` + a matcher,
// the split silently becomes dead code again (the original bug). These tests
// fail loudly in that case.

describe("proxy wiring", () => {
  const orig = {
    public: process.env.PUBLIC_ONLY_HOSTS,
    dashboard: process.env.DASHBOARD_HOSTS,
  };
  beforeEach(() => {
    delete process.env.PUBLIC_ONLY_HOSTS;
    delete process.env.DASHBOARD_HOSTS;
  });
  afterEach(() => {
    if (orig.public === undefined) delete process.env.PUBLIC_ONLY_HOSTS;
    else process.env.PUBLIC_ONLY_HOSTS = orig.public;
    if (orig.dashboard === undefined) delete process.env.DASHBOARD_HOSTS;
    else process.env.DASHBOARD_HOSTS = orig.dashboard;
  });

  it("exports a proxy function and a non-empty matcher", () => {
    expect(typeof proxy).toBe("function");
    expect(Array.isArray(config.matcher)).toBe(true);
    expect(config.matcher.length).toBeGreaterThan(0);
  });

  it("passes through when no host lists are configured (single-host default)", () => {
    const res = proxy(new NextRequest("https://anything.example/api/keys"));
    expect(res.status).toBe(200); // NextResponse.next()
  });

  it("404s the management surface on a public-only host", () => {
    process.env.PUBLIC_ONLY_HOSTS = "public.example";
    const res = proxy(new NextRequest("https://public.example/api/keys"));
    expect(res.status).toBe(404);
  });

  it("allows public canary paths on a public-only host", () => {
    process.env.PUBLIC_ONLY_HOSTS = "public.example";
    for (const path of ["/c/abc123", "/status/abc123", "/api/wallet/v1/log"]) {
      const res = proxy(new NextRequest(`https://public.example${path}`));
      expect(res.status, path).toBe(200);
    }
  });

  it("allows the full surface on a dashboard host", () => {
    process.env.PUBLIC_ONLY_HOSTS = "public.example";
    process.env.DASHBOARD_HOSTS = "private.example";
    const res = proxy(new NextRequest("https://private.example/api/keys"));
    expect(res.status).toBe(200);
  });
});

// MANTIS_PUBLIC_PATH used to change only the minted URL; nothing routed the
// custom prefix, so every canary URL 404'd. The proxy now rewrites it.
describe("MANTIS_PUBLIC_PATH rewrite", () => {
  const orig = process.env.MANTIS_PUBLIC_PATH;
  afterEach(() => {
    if (orig === undefined) delete process.env.MANTIS_PUBLIC_PATH;
    else process.env.MANTIS_PUBLIC_PATH = orig;
  });

  it("maps <prefix>/<id> onto /c/<id> and nothing else", () => {
    expect(publicPathRewrite("/r/Qe6VcVkVkK", "/r")).toBe("/c/Qe6VcVkVkK");
    expect(publicPathRewrite("/track/abc123", "track/")).toBe("/c/abc123");
    expect(publicPathRewrite("/r/not valid", "/r")).toBeNull();
    expect(publicPathRewrite("/r/a/b", "/r")).toBeNull();
    expect(publicPathRewrite("/rx/abc123", "/r")).toBeNull();
    expect(publicPathRewrite("/c/abc123", "/r")).toBeNull();
    expect(publicPathRewrite("/c/abc123", undefined)).toBeNull();
    expect(publicPathRewrite("/c/abc123", "/c")).toBeNull();
  });

  it("proxy rewrites a custom-prefix trigger URL to the handler", () => {
    process.env.MANTIS_PUBLIC_PATH = "/r";
    const res = proxy(new NextRequest("https://mantis.example/r/Qe6VcVkVkK"));
    expect(res.headers.get("x-middleware-rewrite")).toBe(
      "https://mantis.example/c/Qe6VcVkVkK",
    );
  });

  it("proxy leaves other paths alone under a custom prefix", () => {
    process.env.MANTIS_PUBLIC_PATH = "/r";
    const res = proxy(new NextRequest("https://mantis.example/api/keys"));
    expect(res.headers.get("x-middleware-rewrite")).toBeNull();
  });
});
