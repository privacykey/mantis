import type { Hit, MantisClient, NotificationSummary } from "../lib/api.js";
import {
  c,
  emit,
  formatTime,
  glyph,
  isJsonMode,
  table,
  truncate,
} from "../lib/out.js";
import { parseLimit } from "../lib/parse.js";
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
  await withClient(opts, async (client) => {
    const fullId = await resolveKeyRef(client, id);
    const limit = parseLimit(opts.limit);
    const filter = buildFilter(opts);

    if (opts.follow) {
      await followHits(client, fullId, filter, opts);
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
  opts: HitsOpts,
): Promise<void> {
  const intervalMs = Math.max(1000, Number(opts.interval ?? "3") * 1000);
  const seen = new Set<string>();

  // Prime the seen set so we only print *new* hits going forward.
  const initial = await client.listHits(id, { limit: 50 });
  for (const h of initial.data) seen.add(h.id);

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
      const page = await client.listHits(id, { limit: 50 });
      // Oldest-first so we print in arrival order
      for (const h of [...page.data].reverse()) {
        if (seen.has(h.id)) continue;
        seen.add(h.id);
        if (!filter(h)) continue;
        printFollowLine(h);
      }
    } catch (err) {
      process.stderr.write(
        c.red(`follow error: ${err instanceof Error ? err.message : String(err)}\n`),
      );
    }
  }
}

function printFollowLine(h: Hit): void {
  // Under --json, --follow becomes an NDJSON stream: one hit object per line on
  // stdout, so `mantis hits <id> --follow --json | jq -c .` works. The
  // "following…" banner stays on stderr (see followHits) and doesn't pollute it.
  if (isJsonMode()) {
    process.stdout.write(JSON.stringify(h) + "\n");
    return;
  }
  process.stdout.write(
    `${c.dim(formatTime(h.occurred_at))} ${c.cyan(h.ip ?? "-")} ${c.dim(formatUaShort(h))}${h.bot_label ? " " + c.yellow(`bot:${h.bot_label}`) : ""}\n`,
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
    h.ip ?? null,
    h.host_context ? formatHostCtxShort(h.host_context) : formatUaShort(h),
    botCell(h),
    notifyCell(h),
  ]);
  process.stdout.write(
    table(["when", "ip", "who", "tag", "notify"], rows) + "\n",
  );
}

function renderOne(h: Hit): void {
  const w = process.stdout.write.bind(process.stdout);
  w(`${c.bold(h.id)} ${c.dim(`(${formatTime(h.occurred_at)})`)}\n`);
  w(`  ${c.dim("at:    ")} ${h.occurred_at}\n`);
  if (h.host_context) {
    const ctx = h.host_context;
    w(`  ${c.green("host event:")}\n`);
    if (ctx.source) w(`    ${c.dim("source:    ")} ${c.green(ctx.source)}\n`);
    if (ctx.user) w(`    ${c.dim("user:      ")} ${c.cyan(ctx.user)}\n`);
    if (ctx.host) w(`    ${c.dim("host:      ")} ${c.cyan(ctx.host)}\n`);
    if (ctx.ssh_client_ip)
      w(`    ${c.dim("ssh ←:     ")} ${c.yellow(ctx.ssh_client_ip)}\n`);
    if (ctx.ssh_connection)
      w(`    ${c.dim("ssh:       ")} ${ctx.ssh_connection}\n`);
    if (ctx.tty) w(`    ${c.dim("tty:       ")} ${ctx.tty}\n`);
    if (ctx.sudo_cmd)
      w(`    ${c.dim("sudo cmd:  ")} ${c.yellow(ctx.sudo_cmd)}\n`);
    if (ctx.network_interface)
      w(`    ${c.dim("interface: ")} ${ctx.network_interface}\n`);
    if (ctx.event) w(`    ${c.dim("event:     ")} ${c.green(ctx.event)}\n`);
    if (ctx.device) w(`    ${c.dim("device:    ")} ${c.cyan(ctx.device)}\n`);
    if (ctx.entity_id) w(`    ${c.dim("entity:    ")} ${ctx.entity_id}\n`);
    if (ctx.automation) w(`    ${c.dim("automation:")} ${ctx.automation}\n`);
    if (ctx.area) w(`    ${c.dim("area:      ")} ${ctx.area}\n`);
    if (ctx.iot_mac) w(`    ${c.dim("mac:       ")} ${ctx.iot_mac}\n`);
    if (ctx.iot_ip) w(`    ${c.dim("iot ip:    ")} ${ctx.iot_ip}\n`);
  }
  w(`  ${c.dim("ip:    ")} ${h.ip ?? c.dim("-")}\n`);
  w(`  ${c.dim("ua:    ")} ${formatUaLong(h)}\n`);
  if (h.bot_label) w(`  ${c.dim("bot:   ")} ${c.yellow(h.bot_label)}\n`);
  if (h.is_duplicate)
    w(`  ${c.dim("dup:   ")} ${c.dim("yes (suppressed notifications)")}\n`);
  w(`  ${c.dim("ref:   ")} ${h.referer ?? c.dim("-")}\n`);
  if (h.notifications.length > 0) {
    w(`  ${c.dim("notify:")}\n`);
    for (const n of h.notifications) {
      w(`    ${formatNotif(n)}\n`);
    }
  }
  if (h.headers && !isJsonMode()) {
    w(`  ${c.dim("headers:")}\n`);
    for (const [k, v] of Object.entries(h.headers)) {
      w(`    ${c.dim(k + ":")} ${String(v)}\n`);
    }
  }
  w("\n");
}

function formatHostCtxShort(ctx: NonNullable<Hit["host_context"]>): string {
  const parts: string[] = [];
  if (ctx.source) parts.push(c.green(ctx.source));
  if (ctx.user) parts.push(c.cyan(ctx.user));
  if (ctx.host) parts.push("@ " + ctx.host);
  if (ctx.ssh_client_ip)
    parts.push(c.yellow(`${glyph("←", "<-")} ` + ctx.ssh_client_ip));
  if (ctx.sudo_cmd) parts.push(c.yellow("sudo " + ctx.sudo_cmd));
  if (ctx.network_interface) parts.push("iface=" + ctx.network_interface);
  if (ctx.event) parts.push(c.green(ctx.event));
  if (ctx.device) parts.push(c.cyan(ctx.device));
  if (ctx.entity_id) parts.push(ctx.entity_id);
  if (ctx.iot_mac) parts.push(ctx.iot_mac);
  return parts.join(` ${glyph("·", "|")} `);
}

function formatUaShort(h: Hit): string {
  if (h.ua_browser) {
    const ver = h.ua_browser_version ? ` ${h.ua_browser_version}` : "";
    const os = h.ua_os ? ` ${glyph("·", "|")} ${h.ua_os}` : "";
    return `${h.ua_browser}${ver}${os}`;
  }
  return truncate(h.user_agent ?? "", 50);
}

function formatUaLong(h: Hit): string {
  if (h.ua_browser) {
    return `${h.ua_browser} ${h.ua_browser_version ?? ""} on ${h.ua_os ?? "?"} (${h.ua_device ?? "?"})`;
  }
  return h.user_agent ?? "-";
}

function botCell(h: Hit): string {
  if (h.bot_label) return c.yellow(h.bot_label);
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
  let status = n.status;
  let color = c.dim;
  if (n.status === "succeeded") color = c.green;
  else if (n.status === "failed") color = c.red;
  else if (n.status === "pending" || n.status === "in_flight") color = c.yellow;
  const attempts = n.attempts > 0 ? c.dim(` (${n.attempts}/${n.max_attempts})`) : "";
  const err = n.last_error ? `\n      ${c.red(n.last_error.slice(0, 80))}` : "";
  return `${color(status.padEnd(10))} ${n.channel.padEnd(8)} ${c.dim(n.target)}${attempts}${err}`;
}
