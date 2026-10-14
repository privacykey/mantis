// Escapers for attacker-controlled values (host-context parsed from X-Mantis-*
// request headers, User-Agent, key memo) before they are interpolated into
// chat-platform message payloads. Without them, anyone who trips a canary can
// inject markdown links / mentions / formatting into the operator's
// Slack/Discord/Teams alert (phishing, channel pings, spoofed content).
// KEEP IN SYNC with mantis-edge/src/escape.ts.

/**
 * Slack mrkdwn: escaping &, <, > is Slack's documented rule and is sufficient
 * to neutralize `<url|label>` links and `<!here>` / `<@U…>` mentions.
 */
export function escapeSlack(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Value destined for a Slack/Discord inline code span (`…`): a literal backtick
 * would close the span and let the rest break out. Neither platform offers an
 * escape, so swap backticks for a look-alike. Combine with escapeSlack on Slack.
 */
export function escapeCode(s: string): string {
  return s.replace(/`/g, "ʼ");
}

/**
 * Discord and Teams render full markdown in the fields we use, so backslash-
 * escape the metacharacters that enable masked `[label](url)` links, mentions,
 * formatting and blockquotes. Digits/dots/dashes are left intact (literal in
 * markdown) so IPs and UAs stay readable.
 */
export function escapeMarkdown(s: string): string {
  return s.replace(/[\\`*_~|>[\]()]/g, (c) => `\\${c}`);
}

/** Caps literal (unescaped) text at `max` characters, ending in "…" when it was cut. */
export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  let end = max - 1;
  // Don't leave half of a surrogate pair behind.
  const last = s.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return s.slice(0, end) + "…";
}

/**
 * Escapes `s` and caps the ESCAPED text at `max` characters, ending in "…"
 * when it was cut. The chat platforms reject a whole message over one
 * oversized field (Slack: 2000 characters of field text; Discord: 1024 per
 * field value), and escaping grows a value (& → &amp;, _ → \_), so the budget
 * has to be applied after escaping. The cut falls between source characters,
 * so neither an escape sequence nor a surrogate pair is split. `escape` must
 * work character by character, as the escapers above do. (Server-only so far:
 * mantis-edge/src/forward.ts still truncates before escaping.)
 */
export function clipEscaped(
  s: string,
  max: number,
  escape: (s: string) => string,
): string {
  const escaped = escape(s);
  if (escaped.length <= max) return escaped;
  let out = "";
  for (const ch of s) {
    const piece = escape(ch);
    if (out.length + piece.length > max - 1) break;
    out += piece;
  }
  return `${out}…`;
}
