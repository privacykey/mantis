import { ApiError, type Hit, type Key, type MantisClient } from "../lib/api.js";
import {
  c,
  dot,
  emit,
  formatAgo,
  formatDuration,
  formatStamp,
  heading,
  hintLines,
  isJsonMode,
  kv,
  type KvRow,
  mark,
  prose,
  safeText,
  table,
  tripped,
} from "../lib/out.js";
import { deliveryLegend, hitsTable } from "../lib/hit-format.js";
import { parseLimit } from "../lib/parse.js";
import { resolveKeyRef } from "../lib/resolve.js";
import { withClient, type GlobalOpts } from "../lib/runner.js";

export type StatusOpts = GlobalOpts & {
  limit?: string;
  watch?: boolean;
  interval?: string;
  trippedOnly?: boolean;
};

type ServerStatus = { status: "ok" | "tripped"; tripped_at?: string };
type ResolvedStatus = ServerStatus | { status: "off" } | { status: "error"; error: string };

// Monitor state comes from the owner-gated API, addressed by key id — never
// from the public status URL, whose capability the CLI does not hold.
async function fetchStatusSafe(
  client: MantisClient,
  keyId: string,
): Promise<ResolvedStatus> {
  try {
    return await client.fetchStatus(keyId);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return { status: "off" };
    return {
      status: "error",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function statusCmd(
  idOrUndefined: string | undefined,
  opts: StatusOpts,
): Promise<void> {
  await withClient(opts, async (client) => {
    const fullId = idOrUndefined
      ? await resolveKeyRef(client, idOrUndefined)
      : null;

    if (opts.watch && !isJsonMode()) {
      await watchLoop(client, fullId, opts);
      return;
    }

    if (fullId) {
      await detail(client, fullId, opts);
    } else {
      await listAll(client, opts);
    }
  });
}

async function watchLoop(
  client: MantisClient,
  fullId: string | null,
  opts: StatusOpts,
): Promise<void> {
  const intervalMs = Math.max(2000, Number(opts.interval ?? "5") * 1000);

  let stop = false;
  process.on("SIGINT", () => {
    stop = true;
    process.stderr.write("\n");
  });

  while (!stop) {
    // Clear screen + home cursor
    process.stdout.write("\x1b[2J\x1b[H");
    const ts = new Date().toISOString().slice(11, 19);
    process.stderr.write(
      c.dim(`mantis status ${dot()} ${ts} UTC ${dot()} every ${intervalMs / 1000}s, ctrl-c to stop\n\n`),
    );
    try {
      if (fullId) await detail(client, fullId, opts);
      else await listAll(client, opts);
    } catch (err) {
      process.stderr.write(
        c.red(`watch error: ${safeText(err instanceof Error ? err.message : String(err))}\n`),
      );
    }
    if (stop) break;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

async function detail(
  client: MantisClient,
  id: string,
  opts: StatusOpts,
): Promise<void> {
  const key = await client.getKey(id);
  const status = await fetchStatusSafe(client, key.id);
  if (status.status === "error") process.exitCode = 1;

  // Pull the hit slice we need to explain the trip.
  const hitLimit = parseLimit(opts.limit);
  const hitsResp =
    key.monitor_mode === "off"
      ? { data: [] as Hit[], next_cursor: null }
      : await client.listHits(id, { limit: hitLimit });

  const explained = explainTrip(key, status, hitsResp.data);

  emit(
    () => {
      const w = process.stdout.write.bind(process.stdout);
      const short = shortId(key.id);
      w(`${heading(safeText(key.memo), short)}\n`);
      const rows: KvRow[] = [
        ["state", formatStateLong(status)],
        ["mode", formatMode(key)],
      ];

      if (status.status === "tripped" && key.monitor_mode === "window") {
        if (explained.windowExpiresAt) {
          const when = formatRelativeFuture(explained.windowExpiresAt);
          const at = formatStamp(explained.windowExpiresAt.toISOString());
          rows.push([
            "clears",
            `${when} ${c.dim(`${dot()} ${at}, when the oldest hit leaves the window`)}`,
          ]);
        }
      }
      if (status.status === "tripped" && key.monitor_mode === "latch") {
        rows.push(["clears", prose(`on manual reset: \`mantis reset ${short}\``)]);
      }
      if (key.monitor_reset_at) {
        rows.push([
          "last reset",
          `${formatAgo(key.monitor_reset_at)} ${c.dim(`${dot()} ${formatStamp(key.monitor_reset_at)}`)}`,
        ]);
      }
      if (key.monitor_status_url) {
        rows.push(["status URL", c.cyan(safeText(key.monitor_status_url))]);
      }
      w(kv(rows));

      if (key.monitor_mode === "off") {
        process.stderr.write(
          "\n" +
            hintLines(
              `Not monitored. Turn it on with \`mantis monitor ${short} --mode latch\` (or \`--mode window\`).`,
            ),
        );
        return;
      }

      const inWindow = explained.relevantHits;
      if (inWindow.length === 0) {
        w(`\n${c.dim(explained.emptyLabel)}\n`);
        return;
      }

      const noun = inWindow.length === 1 ? "hit" : "hits";
      w(`\n${c.bold(`${inWindow.length} ${noun} ${explained.hitsLabel}`)}\n`);
      w(hitsTable(inWindow) + "\n");
      const legend = deliveryLegend(inWindow);
      process.stderr.write(
        "\n" +
          (legend ? `${legend}\n` : "") +
          hintLines(`\`mantis hits ${short} --verbose\` shows each hit in full.`),
      );
    },
    {
      key: {
        id: key.id,
        public_id: key.public_id,
        memo: key.memo,
        monitor_mode: key.monitor_mode,
        monitor_window_seconds: key.monitor_window_seconds,
        monitor_reset_at: key.monitor_reset_at,
        monitor_status_url: key.monitor_status_url,
        disabled_at: key.disabled_at,
        expires_at: key.expires_at,
      },
      state: status,
      window_expires_at: explained.windowExpiresAt
        ? explained.windowExpiresAt.toISOString()
        : null,
      hits_in_state: explained.relevantHits.map((h) => ({
        id: h.id,
        occurred_at: h.occurred_at,
        ip: h.ip,
        user_agent: h.user_agent,
        bot_label: h.bot_label,
      })),
    },
  );
}

async function listAll(client: MantisClient, opts: StatusOpts): Promise<void> {
  const keys: Key[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listKeys({ limit: 200, cursor });
    keys.push(...page.data);
    cursor = page.next_cursor ?? undefined;
  } while (cursor);

  const monitored = keys.filter((k) => k.monitor_mode !== "off");

  if (monitored.length === 0) {
    emit(
      () => {
        process.stdout.write("No monitored keys yet.\n");
        process.stderr.write(
          hintLines(
            "Turn monitoring on for a key with `mantis monitor <id> --mode latch` (or `--mode window`).",
          ),
        );
      },
      { keys: [] },
    );
    return;
  }

  // Fetch status for each in parallel.
  const statuses = await Promise.all(
    monitored.map(async (k) => ({
      key: k,
      status: await fetchStatusSafe(client, k.id),
    })),
  );

  const failed = statuses.filter(({ status }) => status.status === "error");
  if (failed.length > 0) process.exitCode = 1;
  const filtered = opts.trippedOnly
    ? statuses.filter(({ status }) => status.status === "tripped" || status.status === "error")
    : statuses;

  if (filtered.length === 0 && opts.trippedOnly) {
    emit(
      () => {
        process.stdout.write(
          `${mark("ok")} ${c.green("no monitored keys currently tripped")}\n`,
        );
      },
      { keys: [] },
    );
    return;
  }

  emit(
    () => {
      // Tripped keys are why the command was run, so they come first and
      // carry the weight; the JSON keeps the server's order.
      const rank = (st: ResolvedStatus) =>
        st.status === "tripped" ? 0 : st.status === "error" ? 1 : 2;
      const ordered = [...filtered].sort(
        (a, b) => rank(a.status) - rank(b.status),
      );
      const trippedCount = statuses.filter(
        ({ status }) => status.status === "tripped",
      ).length;
      const total = statuses.length;
      const keysWord = total === 1 ? "key" : "keys";
      const verdict =
        trippedCount > 0
          ? tripped(`${trippedCount} of ${total} monitored ${keysWord} tripped`)
          : failed.length === total
            ? `${mark("warn")} ${c.yellow(`could not read the state of ${total} monitored ${keysWord}`)}`
            : `${mark("ok")} ${c.green(total === 1 ? "the 1 monitored key is ok" : `all ${total} monitored keys are ok`)}`;
      process.stdout.write(`${verdict}\n\n`);

      const rows = ordered.map(({ key, status }) => {
        const loud = status.status === "tripped";
        const id = shortId(key.id);
        const memo = safeText(key.memo);
        return [
          loud ? c.bold(id) : id,
          loud ? c.bold(memo) : memo,
          formatMode(key),
          formatState(status),
          status.status === "tripped" && status.tripped_at
            ? formatAgo(status.tripped_at)
            : "",
        ];
      });
      process.stdout.write(
        table(["id", "memo", "mode", "state", "since"], rows) + "\n",
      );
      const offCount = keys.length - monitored.length;
      const hiddenByFilter = opts.trippedOnly ? monitored.length - filtered.length : 0;
      const notes: string[] = [];
      if (hiddenByFilter > 0) {
        notes.push(
          `${hiddenByFilter} ok ${hiddenByFilter === 1 ? "key" : "keys"} hidden by --tripped-only.`,
        );
      }
      if (offCount > 0) {
        notes.push(
          `${offCount} unmonitored ${offCount === 1 ? "key" : "keys"} not shown; \`mantis list\` shows every key.`,
        );
      }
      if (trippedCount > 0) {
        notes.push("`mantis status <id>` shows what tripped a key.");
      }
      if (notes.length > 0) {
        process.stderr.write("\n" + notes.map((n) => hintLines(n)).join(""));
      }
      if (failed.length > 0) {
        process.stderr.write(
          `\n${mark("warn")} ${c.yellow(`${failed.length} monitor ${failed.length === 1 ? "state is" : "states are"} unavailable.`)} ${c.dim("Check connectivity and retry.")}\n`,
        );
      }
    },
    {
      keys: filtered.map(({ key, status }) => ({
        id: key.id,
        public_id: key.public_id,
        memo: key.memo,
        monitor_mode: key.monitor_mode,
        monitor_window_seconds: key.monitor_window_seconds,
        monitor_status_url: key.monitor_status_url,
        state: status,
      })),
    },
  );
}

function explainTrip(
  key: Key,
  status: ResolvedStatus,
  hits: Hit[],
): {
  relevantHits: Hit[];
  hitsLabel: string;
  emptyLabel: string;
  windowExpiresAt: Date | null;
} {
  if (key.monitor_mode === "off") {
    return {
      relevantHits: [],
      hitsLabel: "",
      emptyLabel: "Not monitored.",
      windowExpiresAt: null,
    };
  }

  // Apply monitor_reset_at filter
  let pool = hits;
  if (key.monitor_reset_at) {
    const cutoff = new Date(key.monitor_reset_at).getTime();
    pool = pool.filter((h) => new Date(h.occurred_at).getTime() > cutoff);
  }

  if (key.monitor_mode === "window") {
    const windowMs = key.monitor_window_seconds * 1000;
    const now = Date.now();
    const cutoff = now - windowMs;
    const inWindow = pool.filter(
      (h) => new Date(h.occurred_at).getTime() > cutoff,
    );
    let windowExpiresAt: Date | null = null;
    if (inWindow.length > 0) {
      const oldestMs = Math.min(
        ...inWindow.map((h) => new Date(h.occurred_at).getTime()),
      );
      windowExpiresAt = new Date(oldestMs + windowMs);
    }
    return {
      relevantHits: inWindow,
      hitsLabel: `in the last ${formatDuration(key.monitor_window_seconds)}`,
      emptyLabel: `No hits in the last ${formatDuration(key.monitor_window_seconds)}.`,
      windowExpiresAt,
    };
  }

  // latch
  // Only render hits if currently tripped; otherwise we'd show pre-reset hits.
  const isTripped = status.status === "tripped";
  return {
    relevantHits: isTripped ? pool : [],
    hitsLabel: key.monitor_reset_at ? "since the last reset" : "so far",
    emptyLabel: key.monitor_reset_at
      ? "No hits since the last reset."
      : "No hits yet.",
    windowExpiresAt: null,
  };
}

function formatMode(key: Key): string {
  if (key.monitor_mode === "off") return c.dim("off");
  if (key.monitor_mode === "latch") return "latch";
  return `window ${formatDuration(key.monitor_window_seconds)}`;
}

/** The state for a table cell: a mark and a word, nothing that can be cut. */
function formatState(status: ResolvedStatus): string {
  if (status.status === "tripped") return tripped();
  if (status.status === "ok") return `${mark("ok")} ${c.green("ok")}`;
  if (status.status === "off") return `${mark("none")} ${c.dim("not monitored")}`;
  if (status.status === "error") {
    return `${mark("warn")} ${c.yellow(`unavailable: ${safeText(status.error)}`)}`;
  }
  return c.dim("?");
}

/** The state for a detail view, with when it tripped. */
function formatStateLong(status: ResolvedStatus): string {
  if (status.status !== "tripped" || !status.tripped_at) {
    return formatState(status);
  }
  const at = status.tripped_at;
  return `${tripped()} ${formatAgo(at)} ${c.dim(`${dot()} ${formatStamp(at)}`)}`;
}

function formatRelativeFuture(d: Date): string {
  const diffMs = d.getTime() - Date.now();
  if (diffMs <= 0) return "now";
  const abs = diffMs;
  if (abs < 60_000) return `in ${Math.round(abs / 1000)}s`;
  if (abs < 3_600_000) return `in ${Math.round(abs / 60_000)}m`;
  if (abs < 86_400_000) return `in ${Math.round(abs / 3_600_000)}h`;
  return `in ${Math.round(abs / 86_400_000)}d`;
}

function shortId(id: string): string {
  return safeText(id).slice(0, 8);
}
