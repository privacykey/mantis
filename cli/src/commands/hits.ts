import type { Hit, Key, MantisClient } from "../lib/api.js";
import {
  heading,
  arrow,
  c,
  dot,
  emit,
  formatAgo,
  formatStamp,
  formatTime,
  hintLines,
  isJsonMode,
  jsonText,
  kv,
  type KvRow,
  KV_LABEL_WIDTH,
  safeText,
  termWidth,
} from "../lib/out.js";
import {
  agentLong,
  agentShort,
  deliveryLegend,
  deliveryLines,
  hitWho,
  hitsTable,
} from "../lib/hit-format.js";
import { parseIntervalMs, parseLimit } from "../lib/parse.js";
import { HitTail } from "../lib/hit-anchor.js";
import { resolveKeyRefDetailed } from "../lib/resolve.js";
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
    const resolved = await resolveKeyRefDetailed(client, id);
    const fullId = resolved.id;
    const limit = parseLimit(opts.limit);
    const filter = buildFilter(opts);

    if (intervalMs !== undefined) {
      await followHits(client, fullId, filter, intervalMs);
      return;
    }

    const page = await client.listHits(fullId, { limit });
    const filtered = page.data.filter(filter);
    emit(
      () =>
        render(filtered, {
          verbose: Boolean(opts.verbose),
          ref: id,
          keyId: fullId,
          key: resolved.key,
          more: page.next_cursor != null,
        }),
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
  const ip = h.ip == null ? c.dim("unknown") : safeText(h.ip);
  const tag = h.bot_label ? ` ${c.dim(`bot: ${safeText(h.bot_label)}`)}` : "";
  process.stdout.write(
    `${c.dim(formatTime(h.occurred_at))} ${ip} ${hitWho(h)}${tag}\n`,
  );
}

type RenderCtx = {
  verbose: boolean;
  /** The reference the operator typed, echoed back in the next-step hints. */
  ref: string;
  keyId: string;
  /** Known when the reference was symbolic (a prefix or `last`). */
  key?: Key;
  /** Whether the page was cut by --limit, so the count is not the total. */
  more?: boolean;
};

/** `8 hits on 3f9ad0c7  AWS creds honeytoken`: what the list below is. */
function contextLine(count: number, ctx: RenderCtx): string {
  const noun = count === 1 ? "hit" : "hits";
  const lead = `${ctx.more ? "Latest " : ""}${count} ${noun}`;
  return titled(lead, ctx);
}

/** `8 hits · <memo>  <id>`: the same heading show and status use, after a plain prefix. */
function titled(lead: string, ctx: RenderCtx): string {
  const shortId = safeText(ctx.keyId).slice(0, 8);
  return ctx.key
    ? `${lead} ${dot()} ${heading(safeText(ctx.key.memo), shortId)}`
    : `${lead} on ${c.bold(shortId)}`;
}

function render(hits: Hit[], ctx: RenderCtx): void {
  const w = process.stdout.write.bind(process.stdout);
  // Footers name the resolved short id, whatever the operator typed.
  const ref = safeText(ctx.keyId).slice(0, 8);
  if (hits.length === 0) {
    w(`${titled("No hits yet", ctx)}\n`);
    process.stderr.write(
      hintLines(`Trigger the key URL, or watch with \`mantis hits ${ref} --follow\`.`),
    );
    return;
  }
  w(`${contextLine(hits.length, ctx)}\n\n`);
  if (ctx.verbose) {
    hits.forEach((h, i) => {
      if (i) w("\n");
      renderOne(h);
    });
    return;
  }
  w(hitsTable(hits) + "\n");
  const legend = deliveryLegend(hits);
  const next = `\`mantis hits ${ref} --verbose\` shows each hit in full.`;
  process.stderr.write(
    "\n" + (legend ? `${legend}\n` : "") + hintLines(next),
  );
}

/** `203.0.113.57:51514 → 10.20.0.5:22` from an SSH_CONNECTION value. */
function sshRoute(raw: string): string {
  const parts = raw.trim().split(/\s+/);
  if (parts.length !== 4) return safeText(raw);
  const [fromIp, fromPort, toIp, toPort] = parts.map(safeText);
  return `${fromIp}:${fromPort} ${arrow.right()} ${toIp}:${toPort}`;
}

// One hit in full: the who, from where and when first, then the detail in
// the shared label block. Empty fields are left out.
function renderOne(h: Hit): void {
  const w = process.stdout.write.bind(process.stdout);
  const s = safeText;
  const ctx = h.host_context;
  const lead = ctx
    ? hitWho({ ...h, host_context: { ...ctx, source: null } })
    : `${h.ip == null ? "unknown address" : c.bold(s(h.ip))} ${dot()} ${agentShort(h)}`;
  w(`${lead} ${c.dim(`${dot()} ${formatAgo(h.occurred_at)} ${dot()} ${s(h.id).slice(0, 8)}`)}\n`);

  const rows: KvRow[] = [["at", formatStamp(h.occurred_at, { seconds: true })]];
  if (ctx?.source) rows.push(["source", s(ctx.source)]);
  if (ctx?.ssh_connection) rows.push(["connection", sshRoute(ctx.ssh_connection)]);
  // Whether anyone was told comes before the rest of the context.
  if (h.is_duplicate) {
    rows.push(["duplicate", c.dim("yes, notifications suppressed")]);
  } else if (h.notifications.length > 0) {
    const room = termWidth() - (2 + KV_LABEL_WIDTH + 1);
    rows.push(["delivery", deliveryLines(h.notifications, room)]);
  }
  if (ctx) {
    if (ctx.tty) rows.push(["tty", s(ctx.tty)]);
    if (ctx.sudo_cmd) rows.push(["sudo", s(ctx.sudo_cmd)]);
    if (ctx.network_interface) rows.push(["interface", s(ctx.network_interface)]);
    if (ctx.event) rows.push(["event", s(ctx.event)]);
    if (ctx.device) rows.push(["device", s(ctx.device)]);
    if (ctx.entity_id) rows.push(["entity", s(ctx.entity_id)]);
    if (ctx.automation) rows.push(["automation", s(ctx.automation)]);
    if (ctx.area) rows.push(["area", s(ctx.area)]);
    if (ctx.iot_mac) rows.push(["mac", s(ctx.iot_mac)]);
    if (ctx.iot_ip) rows.push(["device ip", s(ctx.iot_ip)]);
  }
  // The request's address, unless the line above already says it.
  if (h.ip != null && h.ip !== ctx?.ssh_client_ip) rows.push(["ip", s(h.ip)]);
  if (h.ip == null && !ctx) rows.push(["ip", c.dim("unknown")]);
  rows.push(["agent", agentLong(h)]);
  if (h.bot_label) rows.push(["bot", s(h.bot_label)]);
  if (h.referer != null) rows.push(["referer", s(h.referer)]);
  if (h.is_duplicate && h.notifications.length > 0) {
    const room = termWidth() - (2 + KV_LABEL_WIDTH + 1);
    rows.push(["delivery", deliveryLines(h.notifications, room)]);
  }
  if (h.headers && !isJsonMode()) {
    // x-mantis-* headers are the host context, already drawn as fields above,
    // and a bare `accept` says nothing; --json keeps every header.
    const lines = Object.entries(h.headers)
      .filter(([k]) => !(ctx && k.toLowerCase().startsWith("x-mantis-")))
      .filter(([k]) => k.toLowerCase() !== "accept")
      .map(([k, v]) => c.dim(`${s(k)}: ${s(v)}`));
    if (lines.length > 0) rows.push(["headers", lines]);
  }
  w(kv(rows));
}
