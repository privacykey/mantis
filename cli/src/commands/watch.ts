import type { MantisClient, RecentHit } from "../lib/api.js";
import { c, formatTime, isJsonMode } from "../lib/out.js";
import { resolveKeyRef } from "../lib/resolve.js";
import { withClient, type GlobalOpts } from "../lib/runner.js";

export type WatchOpts = GlobalOpts & {
  interval?: string;
  id?: string;
};

export async function watchCmd(opts: WatchOpts): Promise<void> {
  const intervalMs = Math.max(1000, Number(opts.interval ?? "5") * 1000);

  await withClient(opts, async (client) => {
    const keyId = opts.id ? await resolveKeyRef(client, opts.id) : undefined;
    process.stderr.write(
      c.dim(`watching${opts.id ? ` key ${opts.id}` : ""}; ctrl-c to stop\n`),
    );

    const seen = new Set<string>();
    let since = oneSecondAgo();

    const prime = await client.listRecentHits({
      ...(keyId ? { key_id: keyId } : {}),
      limit: 500,
    });
    for (const hit of prime.data) seen.add(hit.id);
    since = backUpOneMs(newestOccurredAt(prime.data) ?? since);

    const tick = async () => {
      try {
        const hits = await fetchSince(client, since, keyId);
        const newest = newestOccurredAt(hits);
        for (const hit of [...hits].reverse()) {
          if (seen.has(hit.id)) continue;
          seen.add(hit.id);
          print(hit);
        }
        if (newest) since = backUpOneMs(newest);
      } catch (err) {
        process.stderr.write(
          c.red(`watch error: ${err instanceof Error ? err.message : String(err)}\n`),
        );
      }
    };

    const timer = setInterval(tick, intervalMs);
    await new Promise<void>((resolve) => {
      process.on("SIGINT", () => {
        clearInterval(timer);
        process.stderr.write("\n");
        resolve();
      });
    });
  });
}

async function fetchSince(
  client: MantisClient,
  since: string,
  keyId: string | undefined,
): Promise<RecentHit[]> {
  const out: RecentHit[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listRecentHits({
      ...(keyId ? { key_id: keyId } : {}),
      since,
      cursor,
      limit: 500,
    });
    out.push(...page.data);
    cursor = page.next_cursor ?? undefined;
  } while (cursor);
  return out;
}

function print(h: RecentHit): void {
  // Under --json, watch becomes an NDJSON stream: one hit object per line on
  // stdout, so `mantis watch --json | jq -c .` works. The "watching…" banner
  // stays on stderr (see watchCmd) and doesn't pollute the stream.
  if (isJsonMode()) {
    process.stdout.write(JSON.stringify(h) + "\n");
    return;
  }
  const memo = h.key.memo || h.key.id.slice(0, 8);
  const context = h.host_context?.event || h.host_context?.device
    ? ` ${c.green([h.host_context.event, h.host_context.device].filter(Boolean).join(":"))}`
    : "";
  process.stdout.write(
    `${c.dim(formatTime(h.occurred_at))} ${c.bold(memo)}${context} ${c.cyan(h.ip ?? "-")} ${c.dim(h.user_agent ?? "")}\n`,
  );
}

function newestOccurredAt(hits: RecentHit[]): string | undefined {
  let newest: string | undefined;
  for (const hit of hits) {
    if (!newest || Date.parse(hit.occurred_at) > Date.parse(newest)) {
      newest = hit.occurred_at;
    }
  }
  return newest;
}

function backUpOneMs(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  return new Date(t - 1).toISOString();
}

function oneSecondAgo(): string {
  return new Date(Date.now() - 1000).toISOString();
}
