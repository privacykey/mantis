const MAX_CAPTURES = 100;
const MAX_BODY_BYTES = 64 * 1024;

export type Capture = {
  id: number;
  captured_at: string;
  method: string;
  slug: string;
  url: string;
  headers: Record<string, string>;
  body: string;
  body_truncated: boolean;
};

const buffer: Capture[] = [];
let counter = 0;

// Opt-in via ENABLE_DEV_INBOX=1. Captures arbitrary unauthenticated request
// bodies into an in-memory ring buffer — never run with this on in prod.
export function isEnabled(): boolean {
  return process.env.ENABLE_DEV_INBOX === "1";
}

export const REDACTED_HEADER_VALUE = "[redacted]";

// Request headers that carry the SENDER's credentials rather than anything
// about the webhook under test. /inbox/* shares the dashboard's origin on
// single-host and DASHBOARD_HOSTS deployments, so a browser navigating there
// (a link, a redirect-kind canary) attaches the operator's session cookie; an
// access proxy in front adds its own identity assertions. The buffer is
// readable by every full-scope principal, so none of that may be stored.
const CREDENTIAL_HEADER_NAMES = new Set([
  "cookie",
  "cookie2",
  "set-cookie",
  "authorization",
  "proxy-authorization",
  "x-api-key",
  "cf-access-jwt-assertion",
  "cf-access-client-id",
  "cf-access-client-secret",
]);

const CREDENTIAL_HEADER_PATTERNS = [
  /auth/,
  /cookie/,
  /token/,
  /secret/,
  /password/,
  /passwd/,
  /session/,
  /csrf/,
  /xsrf/,
  /credential/,
  /api[-_]?key/,
  /bearer/,
  /jwt/,
  /oidc/,
];

export function isCredentialHeader(name: string): boolean {
  const lower = name.toLowerCase();
  if (CREDENTIAL_HEADER_NAMES.has(lower)) return true;
  return CREDENTIAL_HEADER_PATTERNS.some((re) => re.test(lower));
}

/**
 * Copy of `headers` with every credential-bearing value replaced by
 * "[redacted]". The name is kept so the operator can still see that the header
 * was sent (useful when debugging a webhook's auth), just not what it held.
 */
export function redactCredentialHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    out[name] = isCredentialHeader(name) ? REDACTED_HEADER_VALUE : value;
  }
  return out;
}

export function pushCapture(input: Omit<Capture, "id" | "captured_at">): Capture {
  const cap: Capture = {
    ...input,
    // Enforced here, at the only way into the buffer, so no caller can store
    // an ambient credential by forgetting to redact.
    headers: redactCredentialHeaders(input.headers),
    id: ++counter,
    captured_at: new Date().toISOString(),
  };
  buffer.unshift(cap);
  if (buffer.length > MAX_CAPTURES) buffer.length = MAX_CAPTURES;
  return cap;
}

export function listCaptures(slug?: string): Capture[] {
  if (!slug) return [...buffer];
  return buffer.filter((c) => c.slug === slug);
}

export function clearCaptures(): void {
  buffer.length = 0;
}

export function truncateBody(text: string): { body: string; truncated: boolean } {
  if (text.length <= MAX_BODY_BYTES) return { body: text, truncated: false };
  // Copy, don't just slice: V8 represents a slice of a long string as a view
  // onto its parent, so storing the slice would keep the whole decoded body
  // (up to 1 MiB, 2 MiB as two-byte text) alive for as long as the capture
  // sits in the ring buffer. The utf16le round trip yields an independent
  // string of exactly the kept code units (lone surrogates included).
  const head = Buffer.from(text.slice(0, MAX_BODY_BYTES), "utf16le").toString(
    "utf16le",
  );
  return { body: head, truncated: true };
}
