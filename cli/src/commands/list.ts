import {
  c,
  emit,
  fail,
  formatTime,
  hintLines,
  isWideMode,
  safeText,
  table,
} from "../lib/out.js";
import { parseLimit } from "../lib/parse.js";
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
    const limit = parseLimit(opts.limit);
    const items = await collect(client.listKeys.bind(client), opts.all ? Infinity : limit);
    emit(
      () => {
        if (items.length === 0) {
          process.stdout.write("No keys yet.\n");
          process.stderr.write(hintLines('Create one with `mantis new "first canary"`.'));
          return;
        }
        if (opts.idOnly) {
          process.stdout.write(items.map((t) => safeText(t.id)).join("\n") + "\n");
          return;
        }
        if (opts.urlOnly) {
          process.stdout.write(items.map((t) => safeText(t.url)).join("\n") + "\n");
          return;
        }
        // The memo is whatever the key's creator typed — on an admin listing
        // that includes other API keys' holders — so escape it before cutting.
        // A key that notifies nobody only logs its hits, so its 0 is flagged.
        const dest = (n: number) => (n > 0 ? String(n) : c.yellow("0"));
        const status = (disabled: boolean) => (disabled ? "disabled" : "active");
        const wide = isWideMode();
        const rows = items.map((t) => {
          const row = [wide ? safeText(t.id) : safeText(t.id).slice(0, 8), safeText(t.memo)];
          if (wide) row.push(safeText(t.url));
          row.push(formatTime(t.created_at), dest(t.destinations.length), status(t.disabled));
          return row;
        });
        const columns = wide
          ? ["id", "memo", "url", "age", "notify", "status"]
          : ["id", "memo", "age", "notify", "status"];
        const numeric = wide ? [3, 4] : [2, 3];
        const align = columns.map((_, i) =>
          numeric.includes(i) ? ("right" as const) : ("left" as const),
        );
        process.stdout.write(
          table(columns, rows, {
            align,
            // A disabled key cannot trip, so its row steps back.
            rowStyle: (i) => (items[i]!.disabled ? c.dim : undefined),
          }) + "\n",
        );
        const disabled = items.filter((t) => t.disabled).length;
        const count = `${items.length} ${items.length === 1 ? "key" : "keys"}`;
        process.stderr.write(
          "\n" +
            hintLines(
              `${count}${disabled ? `, ${disabled} disabled` : ""}. \`mantis status\` shows which have tripped.`,
            ),
        );
      },
      { data: items },
    );
  });
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
