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
  formatAge,
  glyph,
  mark,
  type Mark,
  maskSecretUrl,
  safeText,
  table,
  termWidth,
  withoutRepeat,
  wrapProse,
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
export function hitWho(
  h: Hit,
  opts: { omitFrom?: string | null; omitSource?: boolean } = {},
): string {
  const ctx = h.host_context;
  if (!ctx) return agentShort(h);
  const who = identity(ctx);
  const parts: string[] = [];
  // `omitFrom` is an address shown beside this cell already (the ip column).
  if (ctx.ssh_client_ip && ctx.ssh_client_ip !== opts.omitFrom) {
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
  const source = ctx.source && !opts.omitSource ? c.dim(`(${safeText(ctx.source)})`) : "";
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
    if (token) return productForm(token) ?? token;
  }
  if (!ua) return c.dim(glyph("–", "-"));
  return productForm(ua) ?? cutOnWord(ua, 48);
}

/**
 * `aws-cli/2.31.4 md/awscrt#0.27.6 ua/2.1 os/linux#6.8 …` as
 * `aws-cli 2.31.4 · linux`, the form browsers already take; null when the
 * agent does not open with a product token (or opens with `Mozilla/5.0`).
 */
function productForm(ua: string): string | null {
  const product = /^([A-Za-z][\w.-]*)\/(\d[\w.-]*)/.exec(ua);
  if (!product || product[1]!.toLowerCase() === "mozilla") return null;
  const os = /(?:^|\s)os\/([A-Za-z]+)/.exec(ua)?.[1];
  return `${product[1]} ${product[2]}${os ? ` ${dot()} ${os}` : ""}`;
}

/** Cut a long string at a word boundary, with an ellipsis. */
function cutOnWord(s: string, max: number): string {
  if (s.length <= max) return s;
  const ell = glyph("…", "...");
  const space = s.lastIndexOf(" ", max - ell.length);
  const cut = space > max / 2 ? space : max - ell.length;
  return `${s.slice(0, cut)}${ell}`;
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
  if (h.is_duplicate) return "duplicate";
  // In a table the source is a tag, so the who cell stays short.
  return h.host_context?.source ? safeText(h.host_context.source) : "";
}

const NOTIFY_MARK: Record<NotificationSummary["status"], Mark> = {
  succeeded: "ok",
  failed: "fail",
  pending: "pending",
  in_flight: "pending",
  aborted: "none",
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
    if (n) parts.push(`${mark(kind)}${n}`);
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
    // A failed delivery is flagged at the row's left edge, mark and colour.
    const failed = h.notifications.some((n) => n.status === "failed");
    const row = [
      failed ? `${mark("fail")} ${c.red(formatAge(h.occurred_at))}` : formatAge(h.occurred_at),
      h.ip == null ? mark("none") : safeText(h.ip),
      hitWho(h, { omitFrom: h.ip, omitSource: true }),
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
  // Rows of plain ✓ need no legend; once a ✗ or … appears, explain all three.
  if (seen.has("fail") || seen.has("pending")) {
    if (seen.has("ok")) parts.push(`${mark("ok")} ${c.dim("delivered")}`);
    if (seen.has("fail")) parts.push(`${mark("fail")} ${c.dim("failed")}`);
    if (seen.has("pending")) parts.push(`${mark("pending")} ${c.dim("pending")}`);
  }
  // The arrow appears only when the ssh client is not the reporting address.
  const arrowShown = hits.some(
    (h) => h.host_context?.ssh_client_ip && h.host_context.ssh_client_ip !== h.ip,
  );
  if (arrowShown) parts.push(`${arrow.left()} ${c.dim("ssh client address")}`);
  return parts.join("  ");
}

/** `delivered on attempt 1`, `failed after 5 attempts`, `pending, attempt 2 of 5`. */
function deliveryState(n: NotificationSummary): string {
  const a = n.attempts;
  const m = n.max_attempts;
  const ofMax = a > 0 && m > 0 ? `, attempt ${a} of ${m}` : "";
  switch (n.status) {
    case "succeeded":
      return a > 0 ? `delivered on attempt ${a}` : "delivered";
    case "failed":
      if (a > 0 && m > 0 && a >= m) return `failed after ${a} attempt${a === 1 ? "" : "s"}`;
      return `failed${ofMax}`;
    case "pending":
      return `pending${ofMax}`;
    case "in_flight":
      return `sending${ofMax}`;
    case "aborted":
      return "aborted";
    default:
      return safeText(n.status);
  }
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
    const state = deliveryState(n);
    const target =
      n.target != null
        ? maskSecretUrl(safeText(n.target))
        : n.destination_scope === "global"
          ? "(global destination)"
          : "(destination removed)";
    const lead = `${mark(NOTIFY_MARK[n.status] ?? "none")} ${safeText(n.channel).padEnd(channelWidth)}  `;
    const used = 2 + channelWidth + 2 + 2 + state.length;
    lines.push(
      `${lead}${fitMiddle(target, room - used)}  ${n.status === "failed" ? c.red(state) : state}`,
    );
    if (n.last_error) {
      // The reason wraps under the target on a terminal, whole on a pipe,
      // and does not repeat the target the row above names.
      const pad = " ".repeat(2 + channelWidth + 2);
      const reason = withoutRepeat(safeText(n.last_error), n.target ?? "");
      const wrapped = process.stdout.isTTY
        ? wrapProse(reason, Math.max(20, room - pad.length))
        : [reason];
      for (const line of wrapped) lines.push(`${pad}${c.red(line)}`);
    }
  }
  return lines;
}
