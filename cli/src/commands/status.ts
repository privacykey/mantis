import { ApiError, type Hit, type Key, type MantisClient } from "../lib/api.js";
import {
  c,
  emit,
  formatTime,
  isJsonMode,
  table,
  truncate,
} from "../lib/out.js";
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

async function fetchStatusSafe(
  client: MantisClient,
  publicId: string,
): Promise<ResolvedStatus> {
  try {
    return await client.fetchStatus(publicId);
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
    process.stderr.write(c.dim(`mantis status — ${ts} (every ${intervalMs / 1000}s, ctrl-c to stop)\n\n`));
    try {
      if (fullId) await detail(client, fullId, opts);
      else await listAll(client, opts);
    } catch (err) {
      process.stderr.write(
        c.red(`watch error: ${err instanceof Error ? err.message : String(err)}\n`),
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
  const status = await fetchStatusSafe(client, key.public_id);

  // Pull the hit slice we need to explain the trip.
  const hitLimit = Math.max(1, Number(opts.limit ?? "50"));
  const hitsResp =
    key.monitor_mode === "off"
      ? { data: [] as Hit[], next_cursor: null }
      : await client.listHits(id, { limit: hitLimit });

  const explained = explainTrip(key, status, hitsResp.data);

  emit(
    () => {
      const w = process.stdout.write.bind(process.stdout);
      w(`${c.bold(key.memo)} ${c.dim(`(${key.id})`)}\n`);
      w(`  ${c.dim("mode:       ")} ${formatMode(key)}\n`);
      w(`  ${c.dim("state:      ")} ${formatState(status)}\n`);

      if (status.status === "tripped" && key.monitor_mode === "window") {
        if (explained.windowExpiresAt) {
          const inLabel = formatRelativeFuture(explained.windowExpiresAt);
          w(
            `  ${c.dim("window ends:")} ${explained.windowExpiresAt.toISOString()} ${c.dim(`(${inLabel} — oldest in-window hit ages out)`)}\n`,
          );
        }
      }

      if (status.status === "tripped" && key.monitor_mode === "latch") {
        w(
          `  ${c.dim("clears:     ")} on manual reset ${c.dim(`(\`mantis reset ${shortId(key.id)}\`)`)}\n`,
        );
      }

      if (key.monitor_reset_at) {
        w(`  ${c.dim("reset_at:   ")} ${key.monitor_reset_at} ${c.dim(`(${formatTime(key.monitor_reset_at)})`)}\n`);
      }
      if (key.monitor_status_url) {
        w(`  ${c.dim("status URL: ")} ${c.cyan(key.monitor_status_url)}\n`);
      }

      if (key.monitor_mode === "off") {
        w(
          `\n${c.dim(`not monitored — run \`mantis monitor ${shortId(key.id)} --mode latch\` (or --mode window) to enable.`)}\n`,
        );
        return;
      }

      const inWindow = explained.relevantHits;
      if (inWindow.length === 0) {
        w(`\n${c.dim(explained.emptyLabel)}\n`);
        return;
      }

      w(`\n${c.bold(explained.hitsLabel)} (${inWindow.length}):\n`);
      const rows = inWindow.map((h) => [
        formatTime(h.occurred_at),
        h.occurred_at,
        h.ip ?? "-",
        truncate(h.user_agent ?? "", 36),
        h.bot_label ? c.dim(`bot:${h.bot_label}`) : "",
      ]);
      w(
        table(["when", "occurred_at", "ip", "user-agent", "bot"], rows) + "\n",
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
        process.stderr.write(
          c.dim(
            `no keys with monitor_mode set. Run \`mantis monitor <id> --mode latch|window\` to enable.\n`,
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
      status: await fetchStatusSafe(client, k.public_id),
    })),
  );

  const filtered = opts.trippedOnly
    ? statuses.filter(({ status }) => status.status === "tripped")
    : statuses;

  if (filtered.length === 0 && opts.trippedOnly) {
    emit(
      () => {
        process.stderr.write(
          c.green(`✓ no monitored keys currently tripped\n`),
        );
      },
      { keys: [] },
    );
    return;
  }

  emit(
    () => {
      const rows = filtered.map(({ key, status }) => [
        shortId(key.id),
        truncate(key.memo, 32),
        formatMode(key),
        formatState(status),
        status.status === "tripped" && status.tripped_at
          ? formatTime(status.tripped_at)
          : "",
      ]);
      process.stdout.write(
        table(["id", "memo", "mode", "state", "tripped"], rows) + "\n",
      );
      const offCount = keys.length - monitored.length;
      const hiddenByFilter = opts.trippedOnly ? monitored.length - filtered.length : 0;
      const notes: string[] = [];
      if (hiddenByFilter > 0) {
        notes.push(`${hiddenByFilter} ok key${hiddenByFilter === 1 ? "" : "s"} hidden by --tripped-only`);
      }
      if (offCount > 0) {
        notes.push(`${offCount} key${offCount === 1 ? "" : "s"} with monitor_mode=off hidden`);
      }
      if (notes.length > 0) {
        process.stderr.write(c.dim(`\n(${notes.join("; ")})\n`));
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
      emptyLabel: "not monitored",
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
      hitsLabel: `hits in window (${key.monitor_window_seconds}s)`,
      emptyLabel: "no hits in the current window",
      windowExpiresAt,
    };
  }

  // latch
  // Only render hits if currently tripped; otherwise we'd show pre-reset hits.
  const isTripped = status.status === "tripped";
  return {
    relevantHits: isTripped ? pool : [],
    hitsLabel: "hits since last reset",
    emptyLabel: key.monitor_reset_at
      ? "no hits since last reset"
      : "no hits yet",
    windowExpiresAt: null,
  };
}

function formatMode(key: Key): string {
  if (key.monitor_mode === "off") return c.dim("off");
  if (key.monitor_mode === "latch") return c.cyan("latch");
  return c.cyan(`window(${key.monitor_window_seconds}s)`);
}

function formatState(status: ResolvedStatus): string {
  if (status.status === "tripped") {
    const at = status.tripped_at ?? "";
    return `${c.red("⚠ tripped")} ${c.dim(`at ${at} (${formatTime(at)})`)}`;
  }
  if (status.status === "ok") return c.green("✓ ok");
  if (status.status === "off") return c.dim("off / not monitored");
  if (status.status === "error") return c.yellow(`? error: ${status.error}`);
  return c.dim("?");
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
  return id.slice(0, 8);
}
