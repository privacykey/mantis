import { and, desc, eq, gt, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { hits, type Key } from "@/db/schema";

export type MonitorState =
  | { kind: "off" }
  | { kind: "ok" }
  | { kind: "tripped"; trippedAt: Date };

/**
 * Returns the current trip state for a key, derived from `hits` filtered by
 * monitor_reset_at and (in window mode) the recent-window cutoff.
 *
 * Disabled/expired keys are considered "off" — UK shouldn't keep alerting
 * on a key the operator has shut down.
 */
export async function computeMonitorState(key: Key): Promise<MonitorState> {
  if (key.monitorMode === "off") return { kind: "off" };
  if (key.disabledAt !== null) return { kind: "off" };
  if (key.expiresAt && key.expiresAt.getTime() < Date.now()) {
    return { kind: "off" };
  }

  const conditions = [eq(hits.keyId, key.id)];

  if (key.monitorResetAt) {
    conditions.push(gt(hits.occurredAt, key.monitorResetAt));
  }

  if (key.monitorMode === "window") {
    const w = key.monitorWindowSeconds;
    conditions.push(
      gt(hits.occurredAt, sql<Date>`now() - (${w}::int * interval '1 second')`),
    );
  }

  const [row] = await db
    .select({ occurredAt: hits.occurredAt })
    .from(hits)
    .where(and(...conditions))
    .orderBy(desc(hits.occurredAt))
    .limit(1);

  return row ? { kind: "tripped", trippedAt: row.occurredAt } : { kind: "ok" };
}
