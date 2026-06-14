import { and, desc, eq, gt, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { hits } from "@/db/schema";

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
): Promise<HitRecordDecision> {
  if (windowSeconds <= 0) return { record: true, isDuplicate: false };
  const since = sql<Date>`now() - (${windowSeconds}::int * interval '1 second')`;
  const [row] = await db
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

  const [dupes] = await db
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
