// How a hit is drawn, shared by `hits`, `status <id>`, `watch` and
// `destinations test`, so the same event reads the same on every surface.
//
// Everything on a hit except its counters was chosen by whoever fired the key
// (IP, user agent, referer, headers, host context) or whoever configured it
// (destination targets), so every field goes through safeText() before it is
// styled or cut.

import type { Hit, NotificationSummary } from "./api.js";
import {
  arrow,
  c,
  dot,
  fitMiddle,
  formatTime,
  mark,
  type Mark,
  safeText,
  table,
  termWidth,
  truncate,
} from "./out.js";

type HostCtx = NonNullable<Hit["host_context"]>;

/** `deploy@bastion-01`, or whichever half is known. */
function identity(ctx: HostCtx): string | null {
  const user = ctx.user ? safeText(ctx.user) : "";
  const host = ctx.host ? safeText(ctx.host) : "";
  if (user && host) return `${user}@${host}`;
  if (user || host) return user || host;
  const device = ctx.device ?? ctx.entity_id;
  return device ? safeText(device) : null;
}

/**
 * Who tripped the key and from where, on one line:
 * `deploy@bastion-01 ← 203.0.113.57 (shell)`. The identity is the part to
 * read first, so it is the only bold part.
 */
export function hitWho(h: Hit): string {
  const ctx = h.host_context;
  if (!ctx) return agentShort(h);
  const who = identity(ctx);
  const parts: string[] = [];
  if (ctx.ssh_client_ip) {
    parts.push(`${arrow.left()} ${safeText(ctx.ssh_client_ip)}`);
  }
  const facts: string[] = [];
  if (ctx.sudo_cmd) facts.push(`sudo ${safeText(ctx.sudo_cmd)}`);
  if (ctx.event) facts.push(safeText(ctx.event));
  if (ctx.network_interface) facts.push(safeText(ctx.network_interface));
  if (ctx.device && ctx.entity_id) facts.push(safeText(ctx.entity_id));
  if (ctx.iot_mac) facts.push(safeText(ctx.iot_mac));
  const lead = [who ? c.bold(who) : "", ...parts].filter(Boolean).join(" ");
  const body = [lead, ...facts].filter(Boolean).join(` ${dot()} `);
  const source = ctx.source ? c.dim(`(${safeText(ctx.source)})`) : "";
  return [body, source].filter(Boolean).join(" ") || agentShort(h);
}

/** The product token a bot label names inside its user agent. */
function botToken(userAgent: string, label: string): string | null {
  const at = userAgent.toLowerCase().indexOf(label.toLowerCase());
  if (at < 0) return null;
  const m = /^[^\s;()]+(?: \d[\w.]*)?/.exec(userAgent.slice(at));
  return m ? m[0] : null;
}

/** The caller's software in a few words: `Chrome 141 · Windows`. */
export function agentShort(h: Hit): string {
  if (h.ua_browser) {
    const ver = h.ua_browser_version ? ` ${safeText(h.ua_browser_version)}` : "";
    const os = h.ua_os ? ` ${dot()} ${safeText(h.ua_os)}` : "";
    return `${safeText(h.ua_browser)}${ver}${os}`;
  }
  const ua = safeText(h.user_agent);
  if (h.bot_label) {
    const token = botToken(ua, safeText(h.bot_label));
    if (token) return token;
  }
  return ua ? truncate(ua, 48) : c.dim("unknown");
}

/** The caller's software in full, for one hit's detail. */
export function agentLong(h: Hit): string {
  if (h.ua_browser) {
    const ver = h.ua_browser_version ? ` ${safeText(h.ua_browser_version)}` : "";
    const where = [h.ua_os, h.ua_device].filter(Boolean).map(safeText).join(", ");
    return `${safeText(h.ua_browser)}${ver}${where ? ` on ${where}` : ""}`;
  }
  return h.user_agent ? safeText(h.user_agent) : c.dim("unknown");
}

function tagCell(h: Hit): string {
  if (h.bot_label) {
    const label = safeText(h.bot_label);
    const named = botToken(safeText(h.user_agent), label) !== null;
    return named ? "bot" : `bot: ${label}`;
  }
  return h.is_duplicate ? "duplicate" : "";
}

const NOTIFY_MARK: Record<NotificationSummary["status"], Mark> = {
  succeeded: "ok",
  failed: "fail",
  pending: "pending",
  in_flight: "pending",
  aborted: "none",
};

const NOTIFY_WORD: Record<NotificationSummary["status"], string> = {
  succeeded: "delivered",
  failed: "failed",
  pending: "pending",
  in_flight: "sending",
  aborted: "aborted",
};

/** Delivery of one hit's notifications as counts: `✓2 ✗1 …1`. */
export function deliveryCell(h: Hit): string {
  if (h.is_duplicate) return c.dim("suppressed");
  if (h.notifications.length === 0) return c.dim("none");
  const count = (kind: Mark) =>
    h.notifications.filter((n) => NOTIFY_MARK[n.status] === kind).length;
  const parts: string[] = [];
  for (const kind of ["ok", "fail", "pending"] as const) {
    const n = count(kind);
    if (!n) continue;
    const color = kind === "ok" ? c.green : kind === "fail" ? c.red : c.yellow;
    parts.push(`${mark(kind)}${color(String(n))}`);
  }
  return parts.join(" ") || c.dim("aborted");
}

/** A row that is noise next to a real visit: a crawler or a repeat. */
function isQuiet(h: Hit): boolean {
  return Boolean(h.bot_label) || h.is_duplicate;
}

/** The hits table: newest first, crawlers and duplicates dimmed. */
export function hitsTable(hits: Hit[]): string {
  const tags = hits.map(tagCell);
  const showTag = tags.some(Boolean);
  const rows = hits.map((h, i) => {
    const row = [
      formatTime(h.occurred_at),
      h.ip == null ? c.dim("unknown") : safeText(h.ip),
      hitWho(h),
    ];
    if (showTag) row.push(tags[i]!);
    row.push(deliveryCell(h));
    return row;
  });
  const columns = ["when", "ip", "who"];
  if (showTag) columns.push("tag");
  columns.push("delivery");
  return table(columns, rows, {
    align: ["right"],
    rowStyle: (i) => (isQuiet(hits[i]!) ? c.dim : undefined),
  });
}

/** What the delivery marks mean, for the marks that need saying. */
export function deliveryLegend(hits: Hit[]): string {
  const seen = new Set<Mark>();
  for (const h of hits) {
    if (h.is_duplicate) continue;
    for (const n of h.notifications) seen.add(NOTIFY_MARK[n.status]);
  }
  const parts: string[] = [];
  if (seen.has("fail")) parts.push(`${mark("fail")} ${c.dim("failed")}`);
  if (seen.has("pending")) parts.push(`${mark("pending")} ${c.dim("pending")}`);
  return parts.join("  ");
}

/**
 * One line per notification for a hit's detail:
 * `✓ discord  https://discord.com/api/…  delivered, attempt 1 of 5`, with a
 * failure's reason on the next line. `room` is the width left for the lines.
 */
export function deliveryLines(
  notifications: NotificationSummary[],
  room = termWidth(),
): string[] {
  const channelWidth = Math.max(
    ...notifications.map((n) => safeText(n.channel).length),
  );
  const lines: string[] = [];
  for (const n of notifications) {
    const word = NOTIFY_WORD[n.status] ?? safeText(n.status);
    const attempts =
      n.attempts > 0
        ? `, attempt ${safeText(n.attempts)} of ${safeText(n.max_attempts)}`
        : "";
    const state = `${word}${attempts}`;
    const target =
      n.target != null
        ? safeText(n.target)
        : n.destination_scope === "global"
          ? "(global destination)"
          : "(destination removed)";
    const lead = `${mark(NOTIFY_MARK[n.status] ?? "none")} ${safeText(n.channel).padEnd(channelWidth)}  `;
    const used = 2 + channelWidth + 2 + 2 + state.length;
    const stateColor = n.status === "failed" ? c.red : c.dim;
    lines.push(
      `${lead}${fitMiddle(target, room - used)}  ${stateColor(state)}`,
    );
    if (n.last_error) {
      const pad = " ".repeat(2 + channelWidth + 2);
      // Cut to the line on a terminal; piped output keeps the whole reason.
      const reason = safeText(n.last_error);
      const fitted = process.stdout.isTTY
        ? truncate(reason, Math.max(20, room - pad.length))
        : reason;
      lines.push(`${pad}${c.red(fitted)}`);
    }
  }
  return lines;
}
