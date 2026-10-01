import { and, desc, eq, gt, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { hits, keys, type Key } from "@/db/schema";
import { enqueueNotifications } from "@/lib/notify/enqueue";

const DEFAULT_DUPLICATE_LOG_LIMIT = 10;

export type HitRecordDecision =
  | { record: true; isDuplicate: boolean }
  | { record: false; isDuplicate: true };

export function duplicateLogLimit(): number {
  const raw = process.env.MANTIS_DUPLICATE_LOG_LIMIT;
  if (!raw) return DEFAULT_DUPLICATE_LOG_LIMIT;
  const n = Number(raw);
  if (!Number.isInteger(n)) return DEFAULT_DUPLICATE_LOG_LIMIT;
  return Math.min(1000, Math.max(0, n));
}

/**
 * Decide whether to record a hit for `keyId`, honouring the key's dedupe
 * window. The first hit in a window records as primary (isDuplicate:false);
 * subsequent hits record as duplicates up to MANTIS_DUPLICATE_LOG_LIMIT, then
 * stop (record:false). Notifications fire only on the primary record, so this
 * is what bounds per-key notification volume and per-key duplicate growth.
 *
 * Shared by the public trigger route and the Apple Wallet callback path so both
 * get the same dedupe behaviour.
 */
export async function decideHitRecording(
  keyId: string,
  windowSeconds: number,
  client: Pick<typeof db, "select"> = db,
): Promise<HitRecordDecision> {
  if (windowSeconds <= 0) return { record: true, isDuplicate: false };
  const since = sql<Date>`now() - (${windowSeconds}::int * interval '1 second')`;
  const [row] = await client
    .select({ id: hits.id, occurredAt: hits.occurredAt })
    .from(hits)
    .where(
      and(
        eq(hits.keyId, keyId),
        gt(hits.occurredAt, since),
        eq(hits.isDuplicate, false),
      ),
    )
    .orderBy(desc(hits.occurredAt))
    .limit(1);
  if (!row) return { record: true, isDuplicate: false };

  const limit = duplicateLogLimit();
  if (limit <= 0) return { record: false, isDuplicate: true };

  const [dupes] = await client
    .select({ count: sql<number>`count(*)::int` })
    .from(hits)
    .where(
      and(
        eq(hits.keyId, keyId),
        gt(hits.occurredAt, row.occurredAt),
        eq(hits.isDuplicate, true),
      ),
    );

  const duplicateCount = dupes?.count ?? 0;
  return duplicateCount < limit
    ? { record: true, isDuplicate: true }
    : { record: false, isDuplicate: true };
}

/** A primary hit and its delivery jobs commit together, before acknowledging it. */
export async function recordHitWithNotifications(
  key: Key,
  values: Omit<typeof hits.$inferInsert, "keyId" | "isDuplicate">,
) {
  return db.transaction(async (tx) => {
    // Serialize captures for this key so concurrent triggers share one primary
    // notification in the dedupe window. Recheck lifecycle after taking the lock.
    const [current] = await tx.select().from(keys).where(eq(keys.id, key.id)).for("update");
    if (!current || current.disabledAt || (current.expiresAt && current.expiresAt.getTime() <= Date.now())) return null;
    const decision = await decideHitRecording(current.id, current.dedupeWindowSeconds, tx);
    if (!decision.record) return null;
    const [hit] = await tx.insert(hits).values({
      ...values, keyId: current.id, isDuplicate: decision.isDuplicate,
    }).returning();
    if (!hit) throw new Error("hit insert returned no row");
    if (!decision.isDuplicate) await enqueueNotifications(current, hit, tx);
    return hit;
  });
}
