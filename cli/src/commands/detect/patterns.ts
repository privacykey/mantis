/**
 * Centralized URL / token patterns used by every detector. Each pattern
 * carries a vendor label (shown to the operator) and a default severity
 * applied when the match is the only signal we have. Detectors can upgrade
 * severity to "confirmed" when they have stronger context (e.g. a known
 * installer path, a source line in an rc file).
 *
 * Adding a new third-party canary vendor? Append here — every detector that
 * scans content picks it up automatically.
 */
export type UrlPattern = {
  /** Stable id used in Finding.kind (and for sorting). */
  id: string;
  /** Human label, e.g. "canarytokens.com (Thinkst)" or "mantis trigger URL". */
  vendor: string;
  regex: RegExp;
  /** Default severity for "just a pattern match, no other signal". */
  severity: "confirmed" | "suspicious";
};

export const URL_PATTERNS: UrlPattern[] = [
  // Mantis / this project (and legacy canary forks of it). A bare /c/<id>
  // URL is genuinely ambiguous — Cloudflare, URL shorteners, and other
  // services use that path shape — so we only call it suspicious unless a
  // detector pairs it with an X-Mantis-Source: header or a known installer
  // file.
  {
    id: "mantis-trigger",
    vendor: "mantis-style trigger URL",
    regex: /https?:\/\/[^\s"'`<>()\[\]{}]+\/c\/[A-Za-z0-9]{6,32}(?:\?[A-Za-z0-9_=&-]*)?/g,
    severity: "suspicious",
  },

  // Thinkst's free canarytokens service. Distinctive enough that a hit is
  // almost certainly a real token.
  {
    id: "canarytokens-url",
    vendor: "canarytokens.com (Thinkst)",
    regex: /https?:\/\/(?:[a-z0-9-]+\.)*canarytokens\.(?:com|org|net)\/[^\s"'`<>()\[\]{}]*/gi,
    severity: "confirmed",
  },

  // DNS-style canary tokens — Thinkst hands out hostnames under
  // canarytokens.net that fire when resolved. These show up in
  // /etc/hosts, dnsmasq configs, scripts, etc.
  {
    id: "canarytokens-dns",
    vendor: "canarytokens.net (DNS canary)",
    // Require at least one period before to avoid matching the literal
    // string "canarytokens.net" in prose; needs a hostname prefix.
    regex: /\b[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.canarytokens\.net\b/gi,
    severity: "confirmed",
  },

  // Email-style canary token addresses.
  {
    id: "canarytokens-email",
    vendor: "canarytokens.com (email canary)",
    regex: /\b[a-z0-9._%+-]+@canarytokens\.com\b/gi,
    severity: "confirmed",
  },

  // Thinkst's paid Canary appliance ("canary.tools" rebrand from 2023+).
  // Custom subdomains under canary.tools indicate a deployed appliance.
  {
    id: "thinkst-canary-tools",
    vendor: "canary.tools (Thinkst Canary appliance)",
    regex: /\b[a-z0-9-]+\.canary\.tools\b/gi,
    severity: "confirmed",
  },
];

export type PatternMatch = {
  pattern: UrlPattern;
  /** The actual matched text. */
  text: string;
  /** 1-indexed line where the match starts. */
  line: number;
};

/**
 * Scans content against every pattern. Returns all matches, line-numbered.
 * Deduplicates: if multiple patterns hit the same (text, line) pair, only
 * the first (highest-priority) is kept — patterns are listed in the order
 * we want them to win ties.
 */
export function scanContentForPatterns(content: string): PatternMatch[] {
  // Precompute line offsets once for O(1) line lookups per match.
  const lineStarts: number[] = [0];
  for (let i = 0; i < content.length; i++) {
    if (content.charCodeAt(i) === 10) lineStarts.push(i + 1);
  }
  const lineFor = (offset: number): number => {
    // Binary search in lineStarts; +1 for 1-indexed.
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >>> 1;
      if (lineStarts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };

  const matches: PatternMatch[] = [];
  const seen = new Set<string>();
  for (const pattern of URL_PATTERNS) {
    pattern.regex.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = pattern.regex.exec(content)) !== null) {
      const text = m[0];
      const line = lineFor(m.index);
      const key = `${line}|${text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      matches.push({ pattern, text, line });
    }
  }
  return matches;
}
