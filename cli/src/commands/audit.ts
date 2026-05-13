import type { AuditEvent } from "../lib/api.js";
import { c, emit, formatTime, table } from "../lib/out.js";
import { withClient, type GlobalOpts } from "../lib/runner.js";

export type AuditOpts = GlobalOpts & {
  limit?: string;
  since?: string;
  type?: string;
  actor?: string;
};

export async function auditLogCmd(opts: AuditOpts): Promise<void> {
  const limit = opts.limit ? Number(opts.limit) : 100;
  if (!Number.isFinite(limit) || limit < 1 || limit > 500) {
    throw new Error("--limit must be 1-500");
  }
  const sinceMs = parseSince(opts.since);

  await withClient(opts, async (client) => {
    const query: Record<string, string | number> = { limit };
    if (sinceMs !== null) query.since = new Date(sinceMs).toISOString();
    if (opts.type) query.event_type = opts.type;
    if (opts.actor) query.actor = opts.actor;

    const page = await client.listAuditEvents(query);
    emit(
      () => {
        if (page.data.length === 0) {
          process.stdout.write(
            c.dim(
              "no audit events match this filter (try a wider --since or drop --type)\n",
            ),
          );
          return;
        }
        const rows = page.data.map((e) => [
          formatTime(e.occurred_at),
          c.cyan(e.event_type),
          e.actor_label ??
            (e.actor_api_key_id
              ? e.actor_api_key_id.slice(0, 8)
              : c.dim("system")),
          formatSubject(e),
          e.ip ?? "",
        ]);
        process.stdout.write(
          table(["when", "event", "actor", "subject", "ip"], rows) + "\n",
        );
        if (page.next_cursor) {
          process.stderr.write(
            c.dim(
              `\n(more available — widen --since, or use --json and follow next_cursor)\n`,
            ),
          );
        }
      },
      page,
    );
  });
}

function formatSubject(e: AuditEvent): string {
  if (!e.subject_kind && !e.subject_id) return "";
  const id = e.subject_id ? e.subject_id.slice(0, 8) : "";
  return `${e.subject_kind ?? ""}${id ? " " + id : ""}`;
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
  const t = Date.parse(raw);
  if (!Number.isNaN(t)) return t;
  throw new Error(
    `invalid --since: ${raw} (use e.g. 30s, 5m, 2h, 1d, or ISO timestamp)`,
  );
}
