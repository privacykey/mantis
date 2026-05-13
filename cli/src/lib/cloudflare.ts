import { spawnSync } from "node:child_process";
import type { ResolvedCloudflareAuth } from "./config.js";

/** Header name Cloudflare Access checks when authenticating via JWT. */
const HEADER_ACCESS_TOKEN = "cf-access-token";

/** Header pair Cloudflare Access checks when authenticating via Service Auth. */
const HEADER_CLIENT_ID = "CF-Access-Client-Id";
const HEADER_CLIENT_SECRET = "CF-Access-Client-Secret";

/**
 * Cached JWT for the current process. `cloudflared access token` also caches
 * on disk in ~/.cloudflared/, but we cache in memory to avoid the ~50ms
 * subprocess spawn cost on each API call within one CLI invocation.
 */
const jwtCache = new Map<string, string>();

export class CloudflareAuthError extends Error {}

export function cloudflaredInstalled(): boolean {
  const r = spawnSync("cloudflared", ["--version"], { encoding: "utf8" });
  return r.status === 0;
}

/**
 * Asks the local `cloudflared` daemon for the current Cloudflare Access JWT
 * for the given application URL. Returns null if no valid token is cached.
 *
 * `cloudflared access token` prints the token to stdout and exits 0 when
 * a cached token is available. When the cached token is missing or expired,
 * the command exits non-zero with a message like:
 *   "Unable to find token for provided application."
 */
export function fetchCloudflareJwt(appUrl: string): string {
  const cached = jwtCache.get(appUrl);
  if (cached) return cached;

  if (!cloudflaredInstalled()) {
    throw new CloudflareAuthError(
      "`cloudflared` binary not found. Install from https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/ or use --mode service-auth instead.",
    );
  }

  const r = spawnSync(
    "cloudflared",
    ["access", "token", "--app", appUrl],
    { encoding: "utf8" },
  );

  if (r.status !== 0) {
    const stderr = (r.stderr ?? "").trim();
    throw new CloudflareAuthError(
      `cloudflared access token failed: ${stderr || "no cached token"}. Run \`mantis cloudflare login\` to authenticate.`,
    );
  }

  // cloudflared sometimes emits informational lines on stderr and the token on stdout.
  // Strip whitespace and validate.
  const token = (r.stdout ?? "").trim();
  if (!token || token.includes(" ") || token.length < 50) {
    throw new CloudflareAuthError(
      `cloudflared returned no token. Run \`mantis cloudflare login\` to authenticate.`,
    );
  }
  jwtCache.set(appUrl, token);
  return token;
}

/**
 * Drives `cloudflared access login` interactively — opens the user's browser
 * to the Cloudflare Access SSO flow for the given app URL. Returns once the
 * user has completed login and cloudflared has cached the resulting token.
 */
export function cloudflareInteractiveLogin(appUrl: string): void {
  if (!cloudflaredInstalled()) {
    throw new CloudflareAuthError(
      "`cloudflared` binary not found. Install it first.",
    );
  }
  const r = spawnSync("cloudflared", ["access", "login", appUrl], {
    stdio: "inherit",
  });
  if (r.status !== 0) {
    throw new CloudflareAuthError(
      "cloudflared access login failed or was cancelled.",
    );
  }
  jwtCache.delete(appUrl);
}

export function cloudflareInteractiveLogout(appUrl: string): void {
  if (!cloudflaredInstalled()) return;
  spawnSync("cloudflared", ["access", "logout", "--app", appUrl], {
    stdio: "ignore",
  });
  jwtCache.delete(appUrl);
}

/**
 * Builds the header set the request layer should inject for the configured
 * Cloudflare Access auth mode. Returns null when no CF auth is configured.
 */
export function buildCloudflareHeaders(
  cf: ResolvedCloudflareAuth | undefined,
): Record<string, string> | null {
  if (!cf) return null;
  if (cf.mode === "service-auth") {
    return {
      [HEADER_CLIENT_ID]: cf.clientId,
      [HEADER_CLIENT_SECRET]: cf.clientSecret,
    };
  }
  const token = fetchCloudflareJwt(cf.appUrl);
  return { [HEADER_ACCESS_TOKEN]: token };
}
