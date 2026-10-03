import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isAllowedPublicPath } from "@/lib/public-only-hosts";

// In the tailscale-split compose profile the Funnel (internet-facing) node and
// the tailnet-only node proxy to the same mantis container, and tailscaled
// forwards the caller's Host header unchanged. The server's Host-based gate
// therefore cannot tell the two ingresses apart on its own: a Funnel caller
// that sends `Host: <private name>` would be treated as a dashboard request.
// The split is enforced at the ingress instead — docker/tailscale/
// serve-public.json proxies only the path prefixes the server itself treats as
// public. These tests fail when that file and the server's public prefixes
// drift apart in either direction.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ORIGIN = "http://mantis:3000";

type Handler = { Proxy?: string; Path?: string; Text?: string };
type ServeConfig = {
  Web?: Record<string, { Handlers?: Record<string, Handler> }>;
  AllowFunnel?: Record<string, boolean>;
};

function loadServe(name: string): ServeConfig {
  return JSON.parse(
    readFileSync(join(ROOT, "docker/tailscale", name), "utf8"),
  ) as ServeConfig;
}

function handlersOf(config: ServeConfig): Record<string, Handler> {
  const webs = Object.values(config.Web ?? {});
  expect(webs).toHaveLength(1);
  return webs[0]!.Handlers ?? {};
}

/**
 * Mirror of tailscaled's mount lookup (ipn/ipnlocal/serve.go,
 * getServeHandler): an exact match on the request path, then a walk up the
 * cleaned path trying "<dir>/" and "<dir>" at each level. Returns the matching
 * mount point, or null when tailscaled would answer 404 itself.
 */
function mountFor(
  handlers: Record<string, Handler>,
  pathname: string,
): string | null {
  if (Object.hasOwn(handlers, pathname)) return pathname;
  let p = posix.normalize(pathname);
  if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  for (;;) {
    if (Object.hasOwn(handlers, `${p}/`)) return `${p}/`;
    if (Object.hasOwn(handlers, p)) return p;
    if (p === "/") return null;
    p = posix.dirname(p);
  }
}

/** Every page / route handler in src/app, as a concrete sample pathname. */
function appRoutePaths(): string[] {
  const appDir = join(ROOT, "src/app");
  const out = new Set<string>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/^(page|route)\.(ts|tsx)$/.test(entry.name)) continue;
      const segments = relative(appDir, dir)
        .split(sep)
        .filter((s) => s && !/^\(.*\)$/.test(s)) // route groups add no path
        .map((s) =>
          /^\[\.\.\..*\]$/.test(s) ? "a/b" : /^\[.*\]$/.test(s) ? "sample1" : s,
        );
      out.add(`/${segments.join("/")}`);
    }
  };
  walk(appDir);
  return [...out].sort();
}

describe("tailscale-split Funnel serve config (docker/tailscale/serve-public.json)", () => {
  const handlers = handlersOf(loadServe("serve-public.json"));
  const mounts = Object.keys(handlers).sort();

  it("is the Funnel-enabled node and has no catch-all handler", () => {
    const config = loadServe("serve-public.json");
    expect(Object.values(config.AllowFunnel ?? {})).toEqual([true]);
    expect(mounts.length).toBeGreaterThan(0);
    expect(mounts).not.toContain("/");
    expect(mounts).not.toContain("");
  });

  it("proxies each mount to the same path on the mantis origin", () => {
    // tailscaled strips the mount point before proxying and joins the rest
    // onto the Proxy target's path, so the target must repeat the mount for
    // the server to see the original pathname.
    for (const mount of mounts) {
      expect(mount, mount).toMatch(/^\/[A-Za-z0-9._~/-]*[A-Za-z0-9._~-]$/);
      expect(handlers[mount], mount).toEqual({ Proxy: `${ORIGIN}${mount}` });
    }
  });

  it("only mounts prefixes the server treats as public", () => {
    for (const mount of mounts) {
      expect(isAllowedPublicPath(mount), mount).toBe(true);
      expect(isAllowedPublicPath(`${mount}/sample1`), mount).toBe(true);
    }
  });

  it("reaches exactly the routes the server allows on a public-only host", () => {
    const routes = appRoutePaths();
    // Sanity: the walk found both surfaces.
    expect(routes).toContain("/c/sample1");
    expect(routes).toContain("/api/keys");
    for (const path of routes) {
      const reachable = mountFor(handlers, path) !== null;
      expect(
        reachable,
        `${path}: Funnel serve config and isAllowedPublicPath() disagree — ` +
          "update docker/tailscale/serve-public.json to match the server's public prefixes",
      ).toBe(isAllowedPublicPath(path));
    }
  });

  it("serves the public canary paths", () => {
    for (const path of [
      "/c/abc123",
      "/status/abc123",
      "/api/wallet/v1/log",
      "/api/wallet/v1/passes/pass.example/serial1",
    ]) {
      expect(mountFor(handlers, path), path).not.toBeNull();
    }
  });

  it("never reaches the management surface, whatever the path spelling", () => {
    for (const path of [
      "/",
      "/login",
      "/logout",
      "/keys",
      "/keys/new",
      "/settings/notifications",
      "/api/keys",
      "/api/api-keys",
      "/api/audit",
      "/api/hits/recent",
      "/api/cron/notifications",
      "/api/device-profiles",
      // Opt-in on the server (PUBLIC_ONLY_ALLOW_HEALTH / _INBOX); not proxied
      // unless the operator also adds the handler.
      "/api/health",
      "/inbox",
      "/api/inbox",
      // Prefix look-alikes and traversal out of a public mount. tailscaled
      // matches on the cleaned path, so these resolve outside every mount.
      "/cx",
      "/c-admin",
      "/statusx",
      "/api/walletx",
      "/api",
      "/c/../api/keys",
      "/c/../../login",
      "/status/../keys",
      "/api/wallet/../keys",
      "//api/keys",
      "/c/./../login",
    ]) {
      expect(mountFor(handlers, path), path).toBeNull();
    }
  });

  it("shows how a custom MANTIS_PUBLIC_PATH is mirrored", () => {
    const custom = { ...handlers, "/t": { Proxy: `${ORIGIN}/t` } };
    expect(mountFor(handlers, "/t/abc123")).toBeNull();
    expect(mountFor(custom, "/t/abc123")).toBe("/t");
    expect(isAllowedPublicPath("/t/abc123", { publicPath: "/t" })).toBe(true);
  });
});

describe("tailnet-facing serve configs", () => {
  it("keeps the private split node off Funnel and on the full app", () => {
    const config = loadServe("serve-private.json");
    expect(config.AllowFunnel).toBeUndefined();
    expect(handlersOf(config)).toEqual({ "/": { Proxy: ORIGIN } });
  });

  it("keeps the single-host profile proxying the full app", () => {
    expect(handlersOf(loadServe("serve.json"))).toEqual({
      "/": { Proxy: ORIGIN },
    });
  });
});
