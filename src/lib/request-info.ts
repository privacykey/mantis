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

const IP_HEADER_SET: ReadonlySet<string> = new Set(IP_HEADERS);

// Headers whose value is a client-first append chain ("client, proxy1, …"),
// where the LEFTMOST entry is client-supplied and therefore spoofable. These
// get rightmost-hop parsing (the entry TRUST_PROXY_HOPS from the right). The
// remaining IP_HEADERS (cf-connecting-ip, x-real-ip) carry a single
// proxy-written value and keep taking the leftmost token.
const CHAIN_IP_HEADERS: ReadonlySet<string> = new Set([
  "x-forwarded-for",
  "x-vercel-forwarded-for",
]);

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

let warnedUnknownTrustedHeader = false;
function maybeWarnUnknownTrustedHeader(name: string): void {
  if (warnedUnknownTrustedHeader) return;
  warnedUnknownTrustedHeader = true;
  // Avoid pulling in the pino logger here to keep this module edge-safe.
  // eslint-disable-next-line no-console
  console.warn(
    `[mantis] TRUSTED_IP_HEADER="${name}" is not a recognised client-IP ` +
      `header (expected one of: ${IP_HEADERS.join(", ")}). Ignoring it and ` +
      "falling back to the default ordered header list. Fix the value or " +
      "unset it to silence this warning.",
  );
}

type HeaderGetter = (name: string) => string | null | undefined;

/**
 * Extract the client IP from a Headers-like object, applying the trust gate and
 * the rightmost-hop X-Forwarded-For parsing. This is the single source of truth
 * for client-IP attribution; `extractIp` (NextRequest) and the server-action /
 * session paths (which only have `headers()`) all delegate here so none of them
 * can drift back to trusting the spoofable leftmost XFF token.
 *
 * When TRUSTED_IP_HEADER is set to a recognised header, only that header is
 * consulted; an unrecognised value (e.g. a typo) is ignored with a one-time
 * warning so a misconfiguration can't silently null out every client IP.
 * Otherwise the IP_HEADERS list is tried in order (cf-connecting-ip first) for
 * backward compatibility.
 */
export function clientIpFromHeaders(get: HeaderGetter): string | null {
  if (!trustProxyHeaders()) {
    maybeWarnNoProxy();
    return null;
  }
  const pinned = trustedIpHeader();
  let headers: readonly string[];
  if (pinned && IP_HEADER_SET.has(pinned)) {
    headers = [pinned];
  } else {
    if (pinned) maybeWarnUnknownTrustedHeader(pinned);
    headers = IP_HEADERS;
  }
  for (const h of headers) {
    const v = get(h);
    if (!v) continue;
    const parts = v
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);
    if (parts.length === 0) continue;

    if (CHAIN_IP_HEADERS.has(h)) {
      // A client-first append chain ("client, proxy1, …"): the LEFTMOST entry
      // is supplied by the client and is fully spoofable. Take the entry
      // TRUST_PROXY_HOPS from the right (the nearest trusted hop), which a
      // client cannot forge past your proxy layer. Applies to x-forwarded-for
      // and x-vercel-forwarded-for, both of which can arrive comma-joined.
      const ip = parts[Math.max(0, parts.length - trustProxyHops())];
      if (ip) return ip;
    } else {
      // cf-connecting-ip / x-real-ip are single values set by the trusted
      // proxy, not a client-controlled list.
      const ip = parts[0];
      if (ip) return ip;
    }
  }
  return null;
}

export function extractIp(req: NextRequest): string | null {
  return clientIpFromHeaders((n) => req.headers.get(n));
}

// Operator override for the session-cookie Secure flag. "1" forces Secure ON,
// "0" forces it OFF; anything else (incl. unset) defers to the header-derived
// auto-detection. Use "1" behind a genuine-HTTPS front end that sets NEITHER
// X-Forwarded-Proto NOR a RFC 7239 `Forwarded: proto=https` directive (a
// non-standard proxy/tunnel), so the cookie still gets Secure over real TLS.
function forceSecureCookies(): boolean | null {
  const flag = process.env.FORCE_SECURE_COOKIES;
  if (flag === "1") return true;
  if (flag === "0") return false;
  return null;
}

// Whether the FIRST (outermost, client-facing) element of an RFC 7239
// `Forwarded` header declares proto=https. Elements are comma-separated and
// parameters semicolon-separated; parameter names are case-insensitive and the
// value may be quoted (proto="https"). We read the leftmost element to mirror
// the X-Forwarded-Proto leftmost-hop logic.
function forwardedHeaderIsHttps(forwarded: string): boolean {
  const firstElement = forwarded.split(",")[0];
  if (!firstElement) return false;
  for (const pair of firstElement.split(";")) {
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    const key = pair.slice(0, eq).trim().toLowerCase();
    if (key !== "proto") continue;
    let value = pair.slice(eq + 1).trim().toLowerCase();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }
    return value === "https";
  }
  return false;
}

/**
 * Whether the inbound request reached the client over HTTPS, decided from the
 * forwarded scheme rather than NODE_ENV. TLS is terminated by the reverse proxy
 * / tunnel this app documents (Cloudflare, cloudflared, Tailscale Funnel,
 * nginx), each of which sets X-Forwarded-Proto — or the RFC 7239 `Forwarded`
 * header — to the original client scheme.
 *
 * Resolution order:
 *   1. FORCE_SECURE_COOKIES, if set to "1"/"0", wins outright — the operator
 *      escape hatch for a non-standard HTTPS proxy that sets no scheme header.
 *   2. Otherwise: secure if EITHER X-Forwarded-Proto's leftmost hop is "https"
 *      OR the leftmost `Forwarded` element declares proto=https.
 *
 * We return true only on a positive "https" signal. An over-eager Secure flag
 * on a plaintext-HTTP deployment stops the browser from ever sending the cookie
 * back, breaking login — so when nothing proves HTTPS we treat the request as
 * insecure. Absence of every scheme signal means no TLS-terminating proxy is
 * in front (local dev over http://localhost, or a direct HTTP deployment),
 * which is likewise not secure.
 */
export function isSecureRequest(get: HeaderGetter): boolean {
  const override = forceSecureCookies();
  if (override !== null) return override;

  // X-Forwarded-Proto is appended per hop ("https, http"); the LEFTMOST entry
  // is the scheme the client used to reach the outermost proxy.
  const proto = get("x-forwarded-proto");
  if (proto) {
    const scheme = proto.split(",")[0]?.trim().toLowerCase();
    if (scheme === "https") return true;
  }

  // A front end may emit only the RFC 7239 `Forwarded: proto=https` header
  // instead of X-Forwarded-Proto; honour it so genuine HTTPS still gets Secure.
  const forwarded = get("forwarded");
  if (forwarded && forwardedHeaderIsHttps(forwarded)) return true;

  return false;
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
