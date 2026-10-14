import type { MantisClient, RecentHit } from "../lib/api.js";
import { c, formatTime, isJsonMode, jsonText, safeText } from "../lib/out.js";
import { parseIntervalMs } from "../lib/parse.js";
import { HitTail } from "../lib/hit-anchor.js";
import { resolveKeyRef } from "../lib/resolve.js";
import { withClient, type GlobalOpts } from "../lib/runner.js";

export type WatchOpts = GlobalOpts & {
  interval?: string;
  id?: string;
};

export async function watchCmd(opts: WatchOpts): Promise<void> {
  const intervalMs = parseIntervalMs(opts.interval, 5);

  await withClient(opts, async (client) => {
    const keyId = opts.id ? await resolveKeyRef(client, opts.id) : undefined;
    process.stderr.write(
      c.dim(`watching${opts.id ? ` key ${safeText(opts.id)}` : ""}; ctrl-c to stop\n`),
    );

    const prime = await client.listRecentHits({
      ...(keyId ? { key_id: keyId } : {}),
      limit: 500,
      anchor: 1,
    });
    // Each poll re-reads a window behind the watermark, so a hit that became
    // visible late (see HIT_OVERLAP_MS) is still printed; the tail drops the
    // repeats.
    const tail = new HitTail(prime);

    const tick = async () => {
      try {
        const hits = await fetchSince(client, tail.since(), keyId);
        for (const hit of tail.accept(hits)) print(hit);
      } catch (err) {
        process.stderr.write(
          c.red(`watch error: ${safeText(err instanceof Error ? err.message : String(err))}\n`),
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
    process.stdout.write(jsonText(h) + "\n");
    return;
  }
  // Memo, host context, IP and user agent are written by whoever created or
  // fired the key — not necessarily the operator reading this feed.
  const memo = safeText(h.key.memo) || safeText(h.key.id).slice(0, 8);
  const ctxParts = [h.host_context?.event, h.host_context?.device]
    .filter(Boolean)
    .map(safeText);
  const context = ctxParts.length ? ` ${c.green(ctxParts.join(":"))}` : "";
  process.stdout.write(
    `${c.dim(formatTime(h.occurred_at))} ${c.bold(memo)}${context} ${c.cyan(safeText(h.ip ?? "-"))} ${c.dim(safeText(h.user_agent))}\n`,
  );
}
