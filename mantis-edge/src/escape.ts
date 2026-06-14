// Escapers for attacker-controlled values (host-context parsed from X-Mantis-*
// request headers, User-Agent) before they are interpolated into chat-platform
// message payloads. Without them, anyone who fetches a canary edge URL can
// inject markdown links / mentions / formatting into the operator's
// Slack/Discord/Teams alert. KEEP IN SYNC with src/lib/notify/escape.ts.

/** Slack mrkdwn: escaping &, <, > neutralizes `<url|label>` links and `<!here>` / `<@U…>` mentions. */
export function escapeSlack(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Value destined for a Slack/Discord inline code span: a literal backtick would close it. */
export function escapeCode(s: string): string {
  return s.replace(/`/g, "ʼ");
}

/** Discord / Teams render markdown: backslash-escape metachars that enable masked [label](url) links, mentions and formatting. */
export function escapeMarkdown(s: string): string {
  return s.replace(/[\\`*_~|>[\]()]/g, (c) => `\\${c}`);
}

/**
 * Reduce a request URL to a clean origin + path for display, dropping the
 * attacker-controlled query string entirely. The query survives WHATWG URL
 * normalization with markdown metachars intact ((), [], etc.), so it must
 * never be placed inside a markdown link target/label.
 */
export function safeDisplayUrl(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    return `${u.origin}${u.pathname}`;
  } catch {
    return "";
  }
}
