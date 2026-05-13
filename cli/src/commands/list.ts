import { c, emit, fail, formatTime, isWideMode, table } from "../lib/out.js";
import { withClient, type GlobalOpts } from "../lib/runner.js";

export type ListOpts = GlobalOpts & {
  limit?: string;
  all?: boolean;
  idOnly?: boolean;
  urlOnly?: boolean;
};

export async function listCmd(opts: ListOpts): Promise<void> {
  if (opts.idOnly && opts.urlOnly) {
    fail("choose only one of --id-only or --url-only");
  }
  await withClient(opts, async (client) => {
    const limit = opts.limit ? Number(opts.limit) : 50;
    const items = await collect(client.listKeys.bind(client), opts.all ? 1000 : limit);
    emit(
      () => {
        if (items.length === 0) {
          process.stderr.write(
            c.dim(
              "no keys yet. Run `mantis new \"first canary\"` to create one.\n",
            ),
          );
          return;
        }
        if (opts.idOnly) {
          process.stdout.write(items.map((t) => t.id).join("\n") + "\n");
          return;
        }
        if (opts.urlOnly) {
          process.stdout.write(items.map((t) => t.url).join("\n") + "\n");
          return;
        }
        if (isWideMode()) {
          const rows = items.map((t) => [
            t.id,
            truncate(t.memo, 80),
            t.url,
            formatTime(t.created_at),
            t.disabled ? c.red("disabled") : c.green("active"),
            t.destinations.length > 0
              ? c.dim(String(t.destinations.length))
              : "",
          ]);
          process.stdout.write(
            table(["id", "memo", "url", "age", "status", "destinations"], rows) + "\n",
          );
          return;
        }
        const rows = items.map((t) => [
          t.id.slice(0, 8),
          truncate(t.memo, 40),
          formatTime(t.created_at),
          t.disabled ? c.red("disabled") : c.green("active"),
          t.destinations.length > 0
            ? c.dim(String(t.destinations.length))
            : "",
        ]);
        process.stdout.write(
          table(["id", "memo", "age", "status", "destinations"], rows) + "\n",
        );
      },
      { data: items },
    );
  });
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

type Page<T> = { data: T[]; next_cursor: string | null };
async function collect<T>(
  fetcher: (query: { limit?: number; cursor?: string }) => Promise<Page<T>>,
  cap: number,
): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | undefined;
  while (out.length < cap) {
    const remaining = cap - out.length;
    const page = await fetcher({ limit: Math.min(remaining, 200), cursor });
    out.push(...page.data);
    if (!page.next_cursor) break;
    cursor = page.next_cursor;
  }
  return out;
}
