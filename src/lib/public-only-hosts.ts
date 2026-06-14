export type PublicOnlyDecision = {
  publicOnly: boolean;
  allowed: boolean;
};

/**
 * Host-routing decision:
 *   neither list configured     → all paths allowed (single-host deployment)
 *   Host ∈ DASHBOARD_HOSTS      → all paths allowed
 *   Host ∈ PUBLIC_ONLY_HOSTS    → public paths only
 *   Host unknown, public set    → public paths only (fail-closed)
 *   Host unknown, only dash set → 404
 */

const DEFAULT_PUBLIC_PREFIXES = [
  "/c",
  "/status",
  "/api/wallet",
] as const;

function normalizePathPrefix(prefix: string): string {
  const withSlash = prefix.startsWith("/") ? prefix : `/${prefix}`;
  return withSlash.length > 1 ? withSlash.replace(/\/+$/, "") : withSlash;
}

export function normalizeHost(value: string | null | undefined): string | null {
  if (!value) return null;
  let raw = value.trim().toLowerCase();
  if (!raw) return null;

  raw = raw.replace(/^https?:\/\//, "");
  raw = raw.split(/[/?#]/, 1)[0] ?? "";
  raw = raw.replace(/\.$/, "");
  if (!raw) return null;

  if (raw.startsWith("[")) {
    const end = raw.indexOf("]");
    return end >= 0 ? raw.slice(1, end) : raw;
  }

  return raw.split(":", 1)[0] ?? null;
}

function parsePublicOnlyHosts(value: string | null | undefined): Set<string> {
  const hosts = new Set<string>();
  for (const part of (value ?? "").split(/[\s,]+/)) {
    const host = normalizeHost(part);
    if (host) hosts.add(host);
  }
  return hosts;
}

export function isPublicOnlyHost(
  hostHeader: string | null | undefined,
  configuredHosts: string | null | undefined,
): boolean {
  const host = normalizeHost(hostHeader);
  if (!host) return false;
  return parsePublicOnlyHosts(configuredHosts).has(host);
}

function pathMatchesPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

export function isAllowedPublicPath(
  pathname: string,
  opts: {
    publicPath?: string | null;
    allowHealth?: boolean;
    allowInbox?: boolean;
  } = {},
): boolean {
  const prefixes = new Set<string>(DEFAULT_PUBLIC_PREFIXES);
  prefixes.add(normalizePathPrefix(opts.publicPath ?? "/c"));

  if (opts.allowHealth) prefixes.add("/api/health");
  if (opts.allowInbox) {
    prefixes.add("/inbox");
    prefixes.add("/api/inbox");
  }

  for (const prefix of prefixes) {
    if (pathMatchesPrefix(pathname, prefix)) return true;
  }
  return false;
}

export function publicOnlyDecision(input: {
  host: string | null | undefined;
  pathname: string;
  configuredHosts: string | null | undefined;
  configuredDashboardHosts?: string | null | undefined;
  publicPath?: string | null;
  allowHealth?: boolean;
  allowInbox?: boolean;
}): PublicOnlyDecision {
  const publicHosts = parsePublicOnlyHosts(input.configuredHosts);
  const dashboardHosts = parsePublicOnlyHosts(input.configuredDashboardHosts);

  if (publicHosts.size === 0 && dashboardHosts.size === 0) {
    return { publicOnly: false, allowed: true };
  }

  const host = normalizeHost(input.host);

  if (host && dashboardHosts.has(host)) {
    return { publicOnly: false, allowed: true };
  }

  const isPublicMatch = host !== null && publicHosts.has(host);
  const isUnknown = !isPublicMatch && (host === null || !dashboardHosts.has(host));

  // Public match, or fail-closed unknown host when public list is set.
  if (isPublicMatch || (publicHosts.size > 0 && isUnknown)) {
    return {
      publicOnly: true,
      allowed: isAllowedPublicPath(input.pathname, {
        publicPath: input.publicPath,
        allowHealth: input.allowHealth,
        allowInbox: input.allowInbox,
      }),
    };
  }

  // Dashboard-only config + unknown Host.
  return { publicOnly: false, allowed: false };
}
