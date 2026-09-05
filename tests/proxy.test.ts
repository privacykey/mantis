import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { config, proxy } from "@/proxy";

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

describe("custom public trigger prefix", () => {
  afterEach(() => vi.unstubAllEnvs());

  it.each(["/track", "track", "/track/"])("routes %j to the trigger handler", (prefix) => {
    vi.stubEnv("MANTIS_PUBLIC_PATH", prefix);
    vi.stubEnv("PUBLIC_ONLY_HOSTS", "public.example");
    vi.stubEnv("DASHBOARD_HOSTS", "private.example");
    const res = proxy(new NextRequest("https://public.example/track/abc123?source=test"));
    expect(res.headers.get("x-middleware-rewrite")).toBe("https://public.example/c/abc123?source=test");
    expect(proxy(new NextRequest("https://public.example/api/keys")).status).toBe(404);
  });

  it("does not rewrite nested paths or similar prefixes", () => {
    vi.stubEnv("MANTIS_PUBLIC_PATH", "/track");
    vi.stubEnv("PUBLIC_ONLY_HOSTS", "");
    vi.stubEnv("DASHBOARD_HOSTS", "");
    for (const path of ["/tracking/abc123", "/track/abc123/extra", "/api/keys"]) {
      expect(proxy(new NextRequest(`https://example.com${path}`)).headers.get("x-middleware-rewrite")).toBeNull();
    }
  });
});
