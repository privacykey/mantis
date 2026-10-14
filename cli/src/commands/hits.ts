import type { Hit, MantisClient, NotificationSummary } from "../lib/api.js";
import {
  c,
  emit,
  formatTime,
  glyph,
  isJsonMode,
  jsonText,
  safeText,
  table,
  truncate,
} from "../lib/out.js";
import { parseIntervalMs, parseLimit } from "../lib/parse.js";
import { HitTail } from "../lib/hit-anchor.js";
import { resolveKeyRef } from "../lib/resolve.js";
import { withClient, type GlobalOpts } from "../lib/runner.js";

export type HitsOpts = GlobalOpts & {
  limit?: string;
  verbose?: boolean;
  since?: string;
  ip?: string;
  botOnly?: boolean;
  follow?: boolean;
  interval?: string;
};

export async function hitsCmd(id: string, opts: HitsOpts): Promise<void> {
  const intervalMs = opts.follow ? parseIntervalMs(opts.interval, 3) : undefined;
  await withClient(opts, async (client) => {
    const fullId = await resolveKeyRef(client, id);
    const limit = parseLimit(opts.limit);
    const filter = buildFilter(opts);

    if (intervalMs !== undefined) {
      await followHits(client, fullId, filter, intervalMs);
      return;
    }

    const page = await client.listHits(fullId, { limit });
    const filtered = page.data.filter(filter);
    emit(
      () => render(filtered, Boolean(opts.verbose)),
      { data: filtered, next_cursor: page.next_cursor },
    );
  });
}

type HitFilter = (h: Hit) => boolean;

function buildFilter(opts: HitsOpts): HitFilter {
  const sinceMs = parseSince(opts.since);
  const ipFilter = opts.ip;
  const botOnly = Boolean(opts.botOnly);
  if (!sinceMs && !ipFilter && !botOnly) return () => true;
  return (h) => {
    if (sinceMs !== null) {
      const occurredMs = new Date(h.occurred_at).getTime();
      if (occurredMs < sinceMs) return false;
    }
    if (ipFilter && h.ip !== ipFilter) return false;
    if (botOnly && !h.bot_label) return false;
    return true;
  };
}

function parseSince(raw: string | undefined): number | null {
  if (!raw) return null;
  const m = /^(\d+)(s|m|h|d)$/.exec(raw.trim());
  if (m) {
    const n = Number(m[1]);
    const unit = m[2];
    const mult =
      unit === "s" ? 1000 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
    return Date.now() - n * mult;
  }
  // Try ISO date
  const t = Date.parse(raw);
  if (!Number.isNaN(t)) return t;
  throw new Error(`invalid --since: ${raw} (use e.g. 30s, 5m, 2h, 1d, or ISO timestamp)`);
}

async function followHits(
  client: MantisClient,
  id: string,
  filter: HitFilter,
  intervalMs: number,
): Promise<void> {
  // Each poll re-reads a window behind the watermark, so a hit that became
  // visible late (see HIT_OVERLAP_MS) is still printed; the tail drops the
  // repeats by id.
  const initial = await client.listRecentHits({ key_id: id, limit: 500, anchor: 1 });
  const tail = new HitTail(initial);

  process.stderr.write(
    c.dim(`following ${id.slice(0, 8)}; ctrl-c to stop\n`),
  );

  let stop = false;
  process.on("SIGINT", () => {
    stop = true;
    process.stderr.write("\n");
  });

  while (!stop) {
    await new Promise((r) => setTimeout(r, intervalMs));
    if (stop) break;
    try {
      const since = tail.since();
      const arrived: Hit[] = [];
      let cursor: string | undefined;
      do {
        const page = await client.listRecentHits({ key_id: id, since, cursor, limit: 500 });
        arrived.push(...page.data);
        cursor = page.next_cursor ?? undefined;
      } while (cursor);
      // Oldest-first so the stream reflects arrival order.
      for (const h of tail.accept(arrived)) {
        if (!filter(h)) continue;
        printFollowLine(h);
      }
    } catch (err) {
      process.stderr.write(
        c.red(`follow error: ${safeText(err instanceof Error ? err.message : String(err))}\n`),
      );
    }
  }
}

function printFollowLine(h: Hit): void {
  // Under --json, --follow becomes an NDJSON stream: one hit object per line on
  // stdout, so `mantis hits <id> --follow --json | jq -c .` works. The
  // "following…" banner stays on stderr (see followHits) and doesn't pollute it.
  if (isJsonMode()) {
    process.stdout.write(jsonText(h) + "\n");
    return;
  }
  process.stdout.write(
    `${c.dim(formatTime(h.occurred_at))} ${c.cyan(safeText(h.ip ?? "-"))} ${c.dim(formatUaShort(h))}${h.bot_label ? " " + c.yellow(`bot:${safeText(h.bot_label)}`) : ""}\n`,
  );
}

function render(hits: Hit[], verbose: boolean): void {
  if (hits.length === 0) {
    process.stdout.write(
      c.dim("no hits — trigger the key URL to generate one. Or `mantis hits <id> --follow` to watch live.\n"),
    );
    return;
  }
  if (verbose) {
    for (const h of hits) renderOne(h);
    return;
  }
  const rows = hits.map((h) => [
    formatTime(h.occurred_at),
    h.ip == null ? null : safeText(h.ip),
    h.host_context ? formatHostCtxShort(h.host_context) : formatUaShort(h),
    botCell(h),
    notifyCell(h),
  ]);
  process.stdout.write(
    table(["when", "ip", "who", "tag", "notify"], rows) + "\n",
  );
}

// Everything on a hit except its counters was chosen by whoever fired the key
// (IP, user agent, referer, headers, host context) or whoever configured it
// (destination targets), so every field goes through safeText() before it is
// colored or truncated.
function renderOne(h: Hit): void {
  const w = process.stdout.write.bind(process.stdout);
  const s = safeText;
  w(`${c.bold(s(h.id))} ${c.dim(`(${formatTime(h.occurred_at)})`)}\n`);
  w(`  ${c.dim("at:    ")} ${s(h.occurred_at)}\n`);
  if (h.host_context) {
    const ctx = h.host_context;
    w(`  ${c.green("host event:")}\n`);
    if (ctx.source) w(`    ${c.dim("source:    ")} ${c.green(s(ctx.source))}\n`);
    if (ctx.user) w(`    ${c.dim("user:      ")} ${c.cyan(s(ctx.user))}\n`);
    if (ctx.host) w(`    ${c.dim("host:      ")} ${c.cyan(s(ctx.host))}\n`);
    if (ctx.ssh_client_ip)
      w(`    ${c.dim("ssh ←:     ")} ${c.yellow(s(ctx.ssh_client_ip))}\n`);
    if (ctx.ssh_connection)
      w(`    ${c.dim("ssh:       ")} ${s(ctx.ssh_connection)}\n`);
    if (ctx.tty) w(`    ${c.dim("tty:       ")} ${s(ctx.tty)}\n`);
    if (ctx.sudo_cmd)
      w(`    ${c.dim("sudo cmd:  ")} ${c.yellow(s(ctx.sudo_cmd))}\n`);
    if (ctx.network_interface)
      w(`    ${c.dim("interface: ")} ${s(ctx.network_interface)}\n`);
    if (ctx.event) w(`    ${c.dim("event:     ")} ${c.green(s(ctx.event))}\n`);
    if (ctx.device) w(`    ${c.dim("device:    ")} ${c.cyan(s(ctx.device))}\n`);
    if (ctx.entity_id) w(`    ${c.dim("entity:    ")} ${s(ctx.entity_id)}\n`);
    if (ctx.automation) w(`    ${c.dim("automation:")} ${s(ctx.automation)}\n`);
    if (ctx.area) w(`    ${c.dim("area:      ")} ${s(ctx.area)}\n`);
    if (ctx.iot_mac) w(`    ${c.dim("mac:       ")} ${s(ctx.iot_mac)}\n`);
    if (ctx.iot_ip) w(`    ${c.dim("iot ip:    ")} ${s(ctx.iot_ip)}\n`);
  }
  w(`  ${c.dim("ip:    ")} ${h.ip == null ? c.dim("-") : s(h.ip)}\n`);
  w(`  ${c.dim("ua:    ")} ${formatUaLong(h)}\n`);
  if (h.bot_label) w(`  ${c.dim("bot:   ")} ${c.yellow(s(h.bot_label))}\n`);
  if (h.is_duplicate)
    w(`  ${c.dim("dup:   ")} ${c.dim("yes (suppressed notifications)")}\n`);
  w(`  ${c.dim("ref:   ")} ${h.referer == null ? c.dim("-") : s(h.referer)}\n`);
  if (h.notifications.length > 0) {
    w(`  ${c.dim("notify:")}\n`);
    for (const n of h.notifications) {
      w(`    ${formatNotif(n)}\n`);
    }
  }
  if (h.headers && !isJsonMode()) {
    w(`  ${c.dim("headers:")}\n`);
    for (const [k, v] of Object.entries(h.headers)) {
      w(`    ${c.dim(s(k) + ":")} ${s(v)}\n`);
    }
  }
  w("\n");
}

function formatHostCtxShort(ctx: NonNullable<Hit["host_context"]>): string {
  const parts: string[] = [];
  const s = safeText;
  if (ctx.source) parts.push(c.green(s(ctx.source)));
  if (ctx.user) parts.push(c.cyan(s(ctx.user)));
  if (ctx.host) parts.push("@ " + s(ctx.host));
  if (ctx.ssh_client_ip)
    parts.push(c.yellow(`${glyph("←", "<-")} ` + s(ctx.ssh_client_ip)));
  if (ctx.sudo_cmd) parts.push(c.yellow("sudo " + s(ctx.sudo_cmd)));
  if (ctx.network_interface) parts.push("iface=" + s(ctx.network_interface));
  if (ctx.event) parts.push(c.green(s(ctx.event)));
  if (ctx.device) parts.push(c.cyan(s(ctx.device)));
  if (ctx.entity_id) parts.push(s(ctx.entity_id));
  if (ctx.iot_mac) parts.push(s(ctx.iot_mac));
  return parts.join(` ${glyph("·", "|")} `);
}

function formatUaShort(h: Hit): string {
  if (h.ua_browser) {
    const ver = h.ua_browser_version ? ` ${safeText(h.ua_browser_version)}` : "";
    const os = h.ua_os ? ` ${glyph("·", "|")} ${safeText(h.ua_os)}` : "";
    return `${safeText(h.ua_browser)}${ver}${os}`;
  }
  return truncate(safeText(h.user_agent), 50);
}

function formatUaLong(h: Hit): string {
  if (h.ua_browser) {
    return `${safeText(h.ua_browser)} ${safeText(h.ua_browser_version)} on ${safeText(h.ua_os ?? "?")} (${safeText(h.ua_device ?? "?")})`;
  }
  return safeText(h.user_agent ?? "-");
}

function botCell(h: Hit): string {
  if (h.bot_label) return c.yellow(safeText(h.bot_label));
  if (h.is_duplicate) return c.dim("dup");
  return "";
}

function notifyCell(h: Hit): string {
  if (h.is_duplicate) return c.dim("suppressed");
  if (h.notifications.length === 0) return c.dim("-");
  const succeeded = h.notifications.filter((n) => n.status === "succeeded").length;
  const failed = h.notifications.filter((n) => n.status === "failed").length;
  const pending = h.notifications.filter(
    (n) => n.status === "pending" || n.status === "in_flight",
  ).length;
  const parts: string[] = [];
  if (succeeded) parts.push(c.green(`✓${succeeded}`));
  if (pending) parts.push(c.yellow(`⏳${pending}`));
  if (failed) parts.push(c.red(`⚠${failed}`));
  return parts.join(" ");
}

function formatNotif(n: NotificationSummary): string {
  const status = safeText(n.status);
  let color = c.dim;
  if (n.status === "succeeded") color = c.green;
  else if (n.status === "failed") color = c.red;
  else if (n.status === "pending" || n.status === "in_flight") color = c.yellow;
  const attempts =
    n.attempts > 0
      ? c.dim(` (${safeText(n.attempts)}/${safeText(n.max_attempts)})`)
      : "";
  // Escape before cutting, so the 80 columns are counted in visible text.
  const err = n.last_error
    ? `\n      ${c.red(safeText(n.last_error).slice(0, 80))}`
    : "";
  const target =
    n.target != null
      ? safeText(n.target)
      : n.destination_scope === "global"
        ? "(global destination)"
        : "(destination removed)";
  return `${color(status.padEnd(10))} ${safeText(n.channel).padEnd(8)} ${c.dim(target)}${attempts}${err}`;
}
