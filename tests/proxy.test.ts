import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { config, proxy } from "@/proxy";
import { publicPathRewrite } from "@/lib/public-path";
import { statusTag } from "@/lib/status-tag";

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
    const status = `/status/abc123.${statusTag("abc123")}`;
    for (const path of ["/c/abc123", status, "/api/wallet/v1/log"]) {
      const res = proxy(new NextRequest(`https://public.example${path}`));
      expect(res.status, path).toBe(200);
    }
  });

  it("answers a status URL without a valid tag exactly like a blocked path", () => {
    const blocked = (() => {
      process.env.PUBLIC_ONLY_HOSTS = "public.example";
      const res = proxy(new NextRequest("https://public.example/api/keys"));
      delete process.env.PUBLIC_ONLY_HOSTS;
      return res;
    })();
    for (const path of [
      "/status/abc123",
      `/status/abc123.${statusTag("other456")}`,
      "/status/abc123.short",
      "/status/",
      "/status/a/b",
    ]) {
      // On any host, split or not: the capability check does not depend on it.
      const res = proxy(new NextRequest(`https://anything.example${path}`));
      expect(res.status, path).toBe(404);
      expect(res.body, path).toBeNull();
      expect([...res.headers.entries()], path).toEqual([...blocked.headers.entries()]);
    }
    // A valid capability still redirects off a trailing slash like any path.
    const slash = proxy(
      new NextRequest(`https://anything.example/status/abc123.${statusTag("abc123")}/`),
    );
    expect(slash.status).toBe(308);
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

describe("custom public trigger prefix", () => {
  afterEach(() => vi.unstubAllEnvs());

  it.each(["/track", "track", "/track/", " /track/ "])("routes %j to the trigger handler", (prefix) => {
    vi.stubEnv("MANTIS_PUBLIC_PATH", prefix);
    vi.stubEnv("PUBLIC_ONLY_HOSTS", "public.example");
    vi.stubEnv("DASHBOARD_HOSTS", "private.example");
    const res = proxy(new NextRequest("https://public.example/track/abc123?source=test"));
    expect(res.headers.get("x-middleware-rewrite")).toBe("https://public.example/c/abc123?source=test");
    expect(proxy(new NextRequest("https://public.example/api/keys")).status).toBe(404);
  });

  it("does not rewrite similar prefixes, malformed ids or other paths", () => {
    vi.stubEnv("MANTIS_PUBLIC_PATH", "/track");
    vi.stubEnv("PUBLIC_ONLY_HOSTS", "");
    vi.stubEnv("DASHBOARD_HOSTS", "");
    for (const path of ["/tracking/abc123", "/track/abc/extra", "/track/not%20valid/x", "/api/keys"]) {
      expect(proxy(new NextRequest(`https://example.com${path}`)).headers.get("x-middleware-rewrite")).toBeNull();
    }
  });
});

// Bait placed in a base-URL field (aws endpoint_url, API_BASE_URL, kubeconfig
// server) is consumed by tools that append their own path. Those requests must
// reach the trigger handler: /c/<id>/<rest> is a real route, a custom prefix is
// rewritten onto it, and a trailing slash is dropped instead of redirected.
describe("appended paths and trailing slashes on trigger URLs", () => {
  afterEach(() => vi.unstubAllEnvs());

  const rewriteOf = (url: string, init?: { method?: string }) =>
    proxy(new NextRequest(url, init)).headers.get("x-middleware-rewrite");

  it("maps <prefix>/<id>/<anything> onto /c/<id>/<anything>", () => {
    expect(publicPathRewrite("/r/Qe6VcVkVkK/example-prod-uploads", "/r")).toBe(
      "/c/Qe6VcVkVkK/example-prod-uploads",
    );
    expect(publicPathRewrite("/r/Qe6VcVkVkK/2015-03-31/functions", "/r")).toBe(
      "/c/Qe6VcVkVkK/2015-03-31/functions",
    );
    expect(publicPathRewrite("/track/abc123/bucket/key.sql", "track/")).toBe(
      "/c/abc123/bucket/key.sql",
    );
    // A multi-segment prefix, and one that itself sits under /c.
    expect(publicPathRewrite("/a/b/abc123/x", "/a/b")).toBe("/c/abc123/x");
    expect(publicPathRewrite("/c/hooks/abc123/x", "/c/hooks")).toBe("/c/abc123/x");
  });

  it("drops a trailing slash on trigger URLs under any prefix", () => {
    expect(publicPathRewrite("/c/abc123/", undefined)).toBe("/c/abc123");
    expect(publicPathRewrite("/c/abc123/", "/r")).toBe("/c/abc123");
    expect(publicPathRewrite("/r/abc123/", "/r")).toBe("/c/abc123");
    expect(publicPathRewrite("/r/abc123///", "/r")).toBe("/c/abc123");
    expect(publicPathRewrite("/c/abc123/health/", undefined)).toBe("/c/abc123/health");
    expect(publicPathRewrite("/r/abc123/health/", "/r")).toBe("/c/abc123/health");
  });

  it("leaves paths the /c routes already serve, and non-trigger paths, alone", () => {
    expect(publicPathRewrite("/c/abc123", undefined)).toBeNull();
    expect(publicPathRewrite("/c/abc123/health", undefined)).toBeNull();
    expect(publicPathRewrite("/c/abc123/health", "/r")).toBeNull();
    // Never a way out of the trigger prefix: ids must be well-formed.
    expect(publicPathRewrite("/r/abc/x", "/r")).toBeNull();
    expect(publicPathRewrite("/r/abc123x!/x", "/r")).toBeNull();
    expect(publicPathRewrite("/c/", undefined)).toBeNull();
    expect(publicPathRewrite("/api/keys/abc123/hits", "/r")).toBeNull();
    expect(publicPathRewrite("/keys/abc123/", undefined)).toBeNull();
  });

  it("proxy rewrites an appended path under a custom prefix for any method, keeping the query", () => {
    vi.stubEnv("MANTIS_PUBLIC_PATH", "/track");
    for (const method of ["GET", "HEAD", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"]) {
      expect(
        rewriteOf("https://mantis.example/track/abc123/example-prod-uploads?list-type=2", { method }),
        method,
      ).toBe("https://mantis.example/c/abc123/example-prod-uploads?list-type=2");
    }
  });

  it("proxy serves <trigger URL>/ directly instead of redirecting it", () => {
    for (const [prefix, path] of [
      [undefined, "/c/abc123/"],
      ["/track", "/track/abc123/"],
      ["/track", "/c/abc123/"],
    ] as const) {
      if (prefix) vi.stubEnv("MANTIS_PUBLIC_PATH", prefix);
      const res = proxy(new NextRequest(`https://mantis.example${path}?src=nfc`));
      expect(res.status, path).toBe(200);
      expect(res.headers.get("location"), path).toBeNull();
      expect(res.headers.get("x-middleware-rewrite"), path).toBe(
        "https://mantis.example/c/abc123?src=nfc",
      );
    }
  });

  it("an appended path does not widen the public-only host gate", () => {
    vi.stubEnv("MANTIS_PUBLIC_PATH", "/track");
    vi.stubEnv("PUBLIC_ONLY_HOSTS", "public.example");
    vi.stubEnv("DASHBOARD_HOSTS", "private.example");
    // Trigger URLs with an appended path are public, like the bare URL…
    expect(rewriteOf("https://public.example/track/abc123/api/keys")).toBe(
      "https://public.example/c/abc123/api/keys",
    );
    expect(proxy(new NextRequest("https://public.example/c/abc123/api/keys")).status).toBe(200);
    // …and nothing else became reachable: the management surface still 404s,
    // with or without a trailing slash, and is never rewritten or redirected.
    for (const path of ["/api/keys", "/api/keys/", "/keys/abc123/", "/trackx/abc123/x", "/"]) {
      const res = proxy(new NextRequest(`https://public.example${path}`));
      expect(res.status, path).toBe(404);
      expect(res.headers.get("x-middleware-rewrite"), path).toBeNull();
      expect(res.headers.get("location"), path).toBeNull();
    }
    // A rewrite target always stays under /c/<id>, whatever follows the id.
    expect(rewriteOf("https://public.example/track/abc123/..%2f..%2fapi/keys")).toMatch(
      /^https:\/\/public\.example\/c\/abc123\//,
    );
  });
});

// next.config.ts sets skipTrailingSlashRedirect so trigger URLs are not 308'd
// before the proxy runs; the proxy must then reproduce Next's default redirect
// for every other path.
describe("trailing-slash redirect for non-trigger paths", () => {
  afterEach(() => vi.unstubAllEnvs());

  // The proxy hands the runtime an absolute Location on the request's own
  // origin; the runtime sends it to the client path-relative (asserted over
  // real HTTP in tests/tier2/trigger-appended-path.test.ts).
  it("308s /path/ to /path on the request's own origin, keeping the query", () => {
    const res = proxy(new NextRequest("https://dash.example/keys/?tab=hits"));
    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toBe("https://dash.example/keys?tab=hits");

    const api = proxy(new NextRequest("https://dash.example/api/keys/", { method: "POST" }));
    expect(api.status).toBe(308);
    expect(api.headers.get("location")).toBe("https://dash.example/api/keys");

    // A malformed trigger id is not a trigger URL: normal redirect.
    const bad = proxy(new NextRequest("https://dash.example/c/x/"));
    expect(bad.status).toBe(308);
    expect(bad.headers.get("location")).toBe("https://dash.example/c/x");
  });

  it("does not redirect the root or slash-less paths", () => {
    for (const path of ["/", "/keys", "/api/keys", "/c/abc123"]) {
      const res = proxy(new NextRequest(`https://dash.example${path}`));
      expect(res.status, path).toBe(200);
      expect(res.headers.get("location"), path).toBeNull();
    }
  });

  it("never redirects off the request's origin", () => {
    for (const path of [
      "//evil.example/",
      "///evil.example/",
      "/%5Cevil.example/",
      "/\\evil.example/",
      "/%2F%2Fevil.example/",
    ]) {
      const location = proxy(new NextRequest(`https://dash.example${path}`)).headers.get("location");
      if (location !== null) {
        expect(new URL(location).origin, path).toBe("https://dash.example");
        expect(location.includes("\\"), path).toBe(false);
      }
    }
  });

  it("next.config.ts hands trailing slashes to the proxy and covers appended trigger paths", async () => {
    // The two halves must stay together: without skipTrailingSlashRedirect,
    // Next 308s `<trigger URL>/` before the proxy can rewrite it (the bait
    // never fires); with it but without the proxy redirect above, dashboard
    // paths would lose their canonical-URL redirect.
    const { default: nextConfig } = await import("../next.config");
    expect(nextConfig.skipTrailingSlashRedirect).toBe(true);

    const rules = (await nextConfig.headers?.()) ?? [];
    const sources = rules.map((r) => r.source);
    expect(sources).toContain("/c/:publicId");
    expect(sources).toContain("/c/:publicId/:rest+");
    const [exact, appended] = ["/c/:publicId", "/c/:publicId/:rest+"].map(
      (source) => rules.find((r) => r.source === source)!.headers,
    );
    // Same headers on both shapes, and no framing restriction on either.
    expect(appended).toEqual(exact);
    expect(appended!.some((h) => h.key === "X-Frame-Options")).toBe(false);
  });
});
