import { eq, isNull, or } from "drizzle-orm";
import { db } from "@/db/client";
import {
  notificationDestinations,
  notifications,
  type Hit,
  type Key,
} from "@/db/schema";

/**
 * One pending notification row per destination, attached to the hit.
 *
 * Fans out to this key's own destinations PLUS every global destination
 * (keyId IS NULL, configured in /settings/notifications). A key with no
 * destinations of its own still alerts if a global one exists — that's the
 * point of globals, so bulk-minted keys are never silently mute.
 */
export async function enqueueNotifications(
  key: Key,
  hit: Hit,
): Promise<void> {
  const destinations = await db
    .select()
    .from(notificationDestinations)
    .where(
      or(
        eq(notificationDestinations.keyId, key.id),
        isNull(notificationDestinations.keyId),
      ),
    );

  if (destinations.length === 0) return;

  // A key may name the same (channel, target) as a global destination — e.g.
  // the ops Slack webhook set globally AND on this key. Send once, preferring
  // the key's own row so its signing secret and activation history are used.
  const byPair = new Map<string, (typeof destinations)[number]>();
  for (const d of destinations) {
    const pair = `${d.channel}\0${d.target}`;
    const existing = byPair.get(pair);
    if (!existing || (existing.keyId === null && d.keyId !== null)) {
      byPair.set(pair, d);
    }
  }
  const deduped = [...byPair.values()];

  const rows: (typeof notifications.$inferInsert)[] = deduped.map((d) => ({
    hitId: hit.id,
    keyId: key.id,
    destinationId: d.id,
    channel: d.channel as (typeof notifications.$inferInsert)["channel"],
    target: d.target,
    // Denormalized so the worker can sign without a join, and so rotating
    // the destination secret doesn't break in-flight messages.
    signingSecret: d.signingSecret ?? null,
  }));

  await db.insert(notifications).values(rows);
}
