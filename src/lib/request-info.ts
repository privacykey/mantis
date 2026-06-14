import type { NextRequest } from "next/server";

const DEFAULT_MAX_FIELD_CHARS = 16 * 1024;
const DEFAULT_MAX_HEADER_SNAPSHOT_CHARS = 64 * 1024;
const TRUNCATED_MARKER = " [mantis-truncated]";

const IP_HEADERS = [
  "cf-connecting-ip",
  "x-vercel-forwarded-for",
  "x-real-ip",
  "x-forwarded-for",
] as const;

// Honour the IP_HEADERS values when this app sits behind a proxy that
// strips & re-injects them; otherwise treat them as spoofable. Auto-on
// under Vercel and in non-production; explicit opt-in everywhere else.
function trustProxyHeaders(): boolean {
  const flag = process.env.TRUST_PROXY_HEADERS;
  if (flag === "1") return true;
  if (flag === "0") return false;
  if (process.env.VERCEL) return true;
  return process.env.NODE_ENV !== "production";
}

let warnedProdNoProxy = false;
function maybeWarnNoProxy(): void {
  if (warnedProdNoProxy) return;
  if (process.env.NODE_ENV === "production" && !trustProxyHeaders()) {
    warnedProdNoProxy = true;
    // Avoid pulling in the pino logger here to keep this module edge-safe.
    // eslint-disable-next-line no-console
    console.warn(
      "[mantis] TRUST_PROXY_HEADERS is not set and NODE_ENV=production. " +
        "Client IPs will be recorded as null. Set TRUST_PROXY_HEADERS=1 if " +
        "this app sits behind a trusted reverse proxy (Cloudflare, " +
        "cloudflared tunnel, Tailscale Funnel, Vercel, nginx, etc.).",
    );
  }
}

// Number of trusted reverse-proxy hops in front of this app. The client IP in
// X-Forwarded-For is the entry this many positions from the RIGHT (your nearest
// proxy appends the real peer to the right). Default 1 (a single front proxy).
function trustProxyHops(): number {
  return boundedIntEnv("TRUST_PROXY_HOPS", 1, 1, 16);
}

// When set, client-IP extraction trusts ONLY this header and ignores every
// other one in IP_HEADERS. Pin it to the header your proxy authoritatively
// sets (e.g. "x-real-ip" behind nginx/Caddy/Traefik) so an attacker cannot
// smuggle a forged cf-connecting-ip past a proxy that doesn't strip inbound
// copies of it. Unset = the legacy ordered fallback across all IP_HEADERS.
function trustedIpHeader(): string | null {
  const raw = process.env.TRUSTED_IP_HEADER;
  if (!raw) return null;
  const name = raw.trim().toLowerCase();
  return name || null;
}

type HeaderGetter = (name: string) => string | null | undefined;

/**
 * Extract the client IP from a Headers-like object, applying the trust gate and
 * the rightmost-hop X-Forwarded-For parsing. This is the single source of truth
 * for client-IP attribution; `extractIp` (NextRequest) and the server-action /
 * session paths (which only have `headers()`) all delegate here so none of them
 * can drift back to trusting the spoofable leftmost XFF token.
 *
 * When TRUSTED_IP_HEADER is set, only that header is consulted; otherwise the
 * IP_HEADERS list is tried in order (cf-connecting-ip first) for backward
 * compatibility.
 */
export function clientIpFromHeaders(get: HeaderGetter): string | null {
  if (!trustProxyHeaders()) {
    maybeWarnNoProxy();
    return null;
  }
  const pinned = trustedIpHeader();
  const headers: readonly string[] = pinned ? [pinned] : IP_HEADERS;
  for (const h of headers) {
    const v = get(h);
    if (!v) continue;
    const parts = v
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);
    if (parts.length === 0) continue;

    if (h === "x-forwarded-for") {
      // X-Forwarded-For is a client-first append chain ("client, proxy1, …").
      // The LEFTMOST entry is supplied by the client and is fully spoofable;
      // take the entry TRUST_PROXY_HOPS from the right (the nearest trusted
      // hop), which a client cannot forge past your proxy layer.
      const ip = parts[Math.max(0, parts.length - trustProxyHops())];
      if (ip) return ip;
    } else {
      // cf-connecting-ip / x-real-ip / x-vercel-forwarded-for are single values
      // set by the trusted proxy, not a client-controlled list.
      const ip = parts[0];
      if (ip) return ip;
    }
  }
  return null;
}

export function extractIp(req: NextRequest): string | null {
  return clientIpFromHeaders((n) => req.headers.get(n));
}

// Allowlist of request headers stored into hits.headers. The CREDENTIAL_PATTERNS
// denylist runs after, so a credential-shaped name accidentally added here
// (e.g. an `x-auth-*` header) still gets dropped.
const SAFE_HEADER_NAMES = new Set<string>([
  // browser context
  "accept",
  "accept-encoding",
  "accept-language",
  "accept-charset",
  "user-agent",
  "referer",
  "origin",
  // connection meta
  "host",
  "connection",
  "content-type",
  "content-length",
  "content-encoding",
  "range",
  // cache validation
  "cache-control",
  "pragma",
  "if-modified-since",
  "if-none-match",
  // browser security / fingerprint
  "dnt",
  "upgrade-insecure-requests",
  "sec-fetch-site",
  "sec-fetch-mode",
  "sec-fetch-user",
  "sec-fetch-dest",
  "sec-ch-ua",
  "sec-ch-ua-mobile",
  "sec-ch-ua-platform",
  "sec-ch-ua-platform-version",
  // forwarding / IP attribution
  "via",
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-real-ip",
  "cf-connecting-ip",
  "cf-ipcountry",
  "cf-ray",
  "cf-visitor",
  "x-vercel-forwarded-for",
  "x-vercel-id",
  "x-vercel-deployment-url",
  // distributed tracing (W3C)
  "traceparent",
  "tracestate",
]);

const CREDENTIAL_PATTERNS = [
  /auth/,
  /token/,
  /secret/,
  /password/,
  /session/,
  /csrf/,
  /api[-_]?key/,
  /bearer/,
];

function isSafeHeaderName(name: string): boolean {
  // x-mantis-* is the installer protocol and must round-trip.
  if (name.startsWith("x-mantis-")) return true;
  if (!SAFE_HEADER_NAMES.has(name)) return false;
  for (const re of CREDENTIAL_PATTERNS) {
    if (re.test(name)) return false;
  }
  return true;
}

function boundedIntEnv(
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function maxStoredFieldChars(): number {
  return boundedIntEnv(
    "MANTIS_MAX_STORED_REQUEST_FIELD_CHARS",
    DEFAULT_MAX_FIELD_CHARS,
    256,
    256 * 1024,
  );
}

function maxStoredHeaderSnapshotChars(): number {
  return boundedIntEnv(
    "MANTIS_MAX_STORED_HEADER_SNAPSHOT_CHARS",
    DEFAULT_MAX_HEADER_SNAPSHOT_CHARS,
    1024,
    1024 * 1024,
  );
}

export function capStoredRequestField(value: string | null): string | null {
  if (value === null) return null;
  const max = maxStoredFieldChars();
  if (value.length <= max) return value;
  return `${value.slice(
    0,
    Math.max(0, max - TRUNCATED_MARKER.length),
  )}${TRUNCATED_MARKER}`;
}

export function snapshotHeaders(req: NextRequest): Record<string, string> {
  const out: Record<string, string> = {};
  const maxValue = maxStoredFieldChars();
  const maxTotal = maxStoredHeaderSnapshotChars();
  let total = 0;
  let truncated = false;

  for (const [k, v] of req.headers.entries()) {
    const name = k.toLowerCase();
    if (!isSafeHeaderName(name)) continue;

    const value =
      v.length <= maxValue
        ? v
        : `${v.slice(
            0,
            Math.max(0, maxValue - TRUNCATED_MARKER.length),
          )}${TRUNCATED_MARKER}`;
    const nextTotal = total + name.length + value.length;
    if (nextTotal > maxTotal) {
      truncated = true;
      break;
    }
    out[name] = value;
    total = nextTotal;
    if (value !== v) truncated = true;
  }

  if (truncated) {
    out["x-mantis-capture-truncated"] = "headers";
  }

  return out;
}
