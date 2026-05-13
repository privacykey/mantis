import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import {
  notificationDestinations,
  notifications,
  type Hit,
  type Key,
} from "@/db/schema";

/** One pending notification row per destination, attached to the hit. */
export async function enqueueNotifications(
  key: Key,
  hit: Hit,
): Promise<void> {
  const destinations = await db
    .select()
    .from(notificationDestinations)
    .where(eq(notificationDestinations.keyId, key.id));

  if (destinations.length === 0) return;

  const rows: (typeof notifications.$inferInsert)[] = destinations.map((d) => ({
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
