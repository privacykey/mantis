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
 * Which escaper produced the text being truncated:
 *   "slack"    — escapeSlack (entities &amp; &lt; &gt;)
 *   "markdown" — escapeMarkdown (backslash escapes)
 *   "plain"    — no escape sequences (raw text, or escapeCode output)
 */
export type EscapeStyle = "slack" | "markdown" | "plain";

/**
 * Cut an ALREADY-ESCAPED value down to at most `max` characters (the trailing
 * ellipsis included). Chat platforms reject a whole message when one field is
 * over its length limit, and escaping can multiply a value's length (`&`
 * becomes five characters, every markdown metacharacter two), so the budget
 * has to be applied to the escaped text. The cut never lands inside an escape
 * sequence — half an entity (`&am`) or a lone trailing backslash would change
 * how the rest of the message renders — nor inside a surrogate pair.
 */
export function truncateEscaped(
  escaped: string,
  max: number,
  style: EscapeStyle,
): string {
  if (escaped.length <= max) return escaped;
  let end = Math.max(0, max - 1); // room for the ellipsis

  // A high surrogate left without its low half.
  const last = escaped.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;

  if (style === "slack") {
    // Every "&" in Slack-escaped text starts an entity of at most 5 chars.
    const amp = escaped.lastIndexOf("&", end - 1);
    if (amp !== -1 && end - amp < 5) {
      const semi = escaped.indexOf(";", amp);
      if (semi === -1 || semi >= end) end = amp;
    }
  } else if (style === "markdown") {
    // Backslashes come in escape pairs; an odd run at the cut has lost the
    // character it was escaping.
    let run = 0;
    while (run < end && escaped[end - 1 - run] === "\\") run++;
    if (run % 2 === 1) end -= 1;
  }

  return `${escaped.slice(0, end)}…`;
}

/**
 * Reduce a request URL to a clean origin + path for display, dropping the
 * attacker-controlled query string entirely. The query survives WHATWG URL
 * normalization with markdown metachars intact ((), [], etc.), so it must
 * never be placed inside a markdown link target/label.
 *
 * NOTE: for an edge URL the result is still the LIVE trigger. Never put it in
 * a chat alert — use triggerLabel() there.
 */
export function safeDisplayUrl(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    return `${u.origin}${u.pathname}`;
  } catch {
    return "";
  }
}

const TRIGGER_ID_CHARS = 10;

/**
 * Inert description of the edge URL that was hit, for chat alerts: the host
 * and the first few characters of the sealed blob.
 *
 * Chat alerts must never carry the URL itself. The URL IS the trigger, and
 * the Worker keeps no state to dedupe with — so a click on the alert, a link
 * preview, or a security scanner following the link would fire the canary
 * again and post another alert carrying the same link. The fragment
 * identifies which minted URL fired (compare it with the start of the blob
 * you minted) but is far too short to unseal, so nothing built from it can
 * fire anything.
 */
export function triggerLabel(rawUrl: string): { id: string; host: string } {
  try {
    const u = new URL(rawUrl);
    const blob = /^\/c\/([A-Za-z0-9_-]+)$/.exec(u.pathname)?.[1];
    return {
      id: blob ? `${blob.slice(0, TRIGGER_ID_CHARS)}…` : "unknown",
      host: u.host || "unknown",
    };
  } catch {
    return { id: "unknown", host: "unknown" };
  }
}
