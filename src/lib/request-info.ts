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
        "cloudflared tunnel, Tailscale Funnel, Vercel, nginx, etc.), and " +
        "pin TRUSTED_IP_HEADER to the one header that proxy writes " +
        `(${PIN_GUIDANCE}).`,
    );
  }
}

// Shared by the boot warnings below; mirrors the table in .env.example.
const PIN_GUIDANCE =
  "cf-connecting-ip behind Cloudflare / cloudflared; x-forwarded-for behind " +
  "Tailscale serve/Funnel, Fly or Render; x-real-ip or x-forwarded-for " +
  "behind nginx/Caddy/Traefik, whichever it is configured to set; " +
  "x-vercel-forwarded-for on Vercel";

let warnedUnpinned = false;
function maybeWarnUnpinned(): void {
  if (warnedUnpinned) return;
  // Production only: the non-production default trusts headers so local dev
  // sees IPs, and nagging there (or in tests) would just be noise.
  if (process.env.NODE_ENV !== "production") return;
  warnedUnpinned = true;
  // Avoid pulling in the pino logger here to keep this module edge-safe.
  // eslint-disable-next-line no-console
  console.warn(
    "[mantis] Client-IP headers are trusted but TRUSTED_IP_HEADER is not " +
      `set, so the first header present out of ${IP_HEADERS.join(", ")} ` +
      "wins. Any of those your proxy does not overwrite can be sent by the " +
      "client, which lets it choose the IP recorded on hits and used for " +
      "per-IP limits. Pin the one header your ingress writes: " +
      `${PIN_GUIDANCE}.`,
  );
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
// copies of it. Unset = the legacy ordered fallback across all IP_HEADERS,
// which is only safe behind an ingress that overwrites the FIRST header in
// that order it lets through (Cloudflare does; a proxy that writes only
// X-Forwarded-For does not) — hence the one-time warning when it is unset.
function trustedIpHeader(): string | null {
  const raw = process.env.TRUSTED_IP_HEADER;
  if (!raw) return null;
  const name = raw.trim().toLowerCase();
  return name || null;
}

let warnedUnknownTrustedHeader = false;
function maybeWarnUnknownTrustedHeader(): void {
  if (warnedUnknownTrustedHeader) return;
  warnedUnknownTrustedHeader = true;
  // Avoid pulling in the pino logger here to keep this module edge-safe.
  // Deliberately do NOT echo the configured value back into the log: it is
  // operator-supplied environment data, and logging it verbatim trips
  // js/clear-text-logging and risks log injection via crafted values. Naming
  // the accepted set is equally actionable — the operator set the value.
  // eslint-disable-next-line no-console
  console.warn(
    "[mantis] TRUSTED_IP_HEADER is set to an unrecognised value (expected one " +
      `of: ${IP_HEADERS.join(", ")}). Ignoring it and falling back to the ` +
      "default ordered header list. Fix the value or unset it to silence this " +
      "warning.",
  );
}

type HeaderGetter = (name: string) => string | null | undefined;

const IPV4_RE =
  /^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const IPV6_GROUP_RE = /^[0-9A-Fa-f]{1,4}$/;
const IPV6_ZONE_RE = /^[0-9A-Za-z._-]{1,32}$/;

function isIpv6Literal(value: string): boolean {
  // Longest textual form (IPv4-embedded, fully expanded) is 45 chars.
  if (value.length < 2 || value.length > 45) return false;
  const halves = value.split("::");
  if (halves.length > 2) return false;
  const groups = halves.flatMap((half) => (half === "" ? [] : half.split(":")));
  let count = 0;
  for (let i = 0; i < groups.length; i++) {
    const group = groups[i] ?? "";
    if (i === groups.length - 1 && group.includes(".")) {
      // Trailing dotted quad (::ffff:203.0.113.9) stands for two groups.
      if (!IPV4_RE.test(group)) return false;
      count += 2;
    } else {
      if (!IPV6_GROUP_RE.test(group)) return false;
      count += 1;
    }
  }
  // "::" stands for at least one zero group; without it all eight are spelled.
  return halves.length === 2 ? count <= 7 : count === 8;
}

/**
 * Returns `token` as a bare IP address when it is a syntactically valid IPv4 or
 * IPv6 literal, else null. Tolerates the decorations real proxies add — a port
 * ("203.0.113.9:4711", "[2001:db8::1]:4711"), brackets, an IPv6 zone — and
 * strips port and brackets so one client maps to one value. Hand-rolled rather
 * than node:net's isIP to keep this module edge-safe.
 */
export function parseIpLiteral(token: string): string | null {
  let value = token.trim();
  if (value.startsWith("[")) {
    const bracketed = /^\[([^\]]+)\](?::\d{1,5})?$/.exec(value);
    if (!bracketed?.[1]) return null;
    value = bracketed[1];
  } else {
    const withPort = /^([^:]+):\d{1,5}$/.exec(value);
    if (withPort?.[1]) value = withPort[1];
  }
  if (IPV4_RE.test(value)) return value;

  const zoneAt = value.indexOf("%");
  const address = zoneAt === -1 ? value : value.slice(0, zoneAt);
  if (zoneAt !== -1 && !IPV6_ZONE_RE.test(value.slice(zoneAt + 1))) return null;
  return isIpv6Literal(address) ? value : null;
}

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
 * backward compatibility, with a one-time production warning to pin it.
 *
 * Whichever header wins, its value must be an IP literal; anything else is
 * skipped and the next header consulted, so free text can never be recorded as
 * a client IP or used as a limiter key.
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
    if (pinned) maybeWarnUnknownTrustedHeader();
    else maybeWarnUnpinned();
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

    // A client-first append chain ("client, proxy1, …"): the LEFTMOST entry
    // is supplied by the client and is fully spoofable. Take the entry
    // TRUST_PROXY_HOPS from the right (the nearest trusted hop), which a
    // client cannot forge past your proxy layer. Applies to x-forwarded-for
    // and x-vercel-forwarded-for, both of which can arrive comma-joined.
    // cf-connecting-ip / x-real-ip are single values set by the trusted
    // proxy, not a client-controlled list.
    const candidate = CHAIN_IP_HEADERS.has(h)
      ? parts[Math.max(0, parts.length - trustProxyHops())]
      : parts[0];
    const ip = candidate ? parseIpLiteral(candidate) : null;
    if (ip) return ip;
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
