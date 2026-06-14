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
