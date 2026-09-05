import { inArray } from "drizzle-orm";
import { db } from "@/db/client";
import {
  notificationDestinations,
  type ApiKey,
  type Notification,
} from "@/db/schema";

export type DestinationScope = "key" | "global" | "unknown";

export type SerializedHitNotification = {
  id: string;
  channel: Notification["channel"];
  /**
   * The destination target. `null` when the caller may not see it: a
   * non-admin only sees targets of destinations attached to the key itself.
   * Global destinations (settings → notifications) are admin-configured and
   * their URLs are credentials (Slack / Discord / Teams / Home Assistant
   * webhooks), so they are never handed to a non-admin key owner. A
   * destination that has since been deleted can't be attributed, so it is
   * redacted for non-admins too.
   */
  target: string | null;
  destination_scope: DestinationScope;
  status: Notification["status"];
  attempts: number;
  max_attempts: number;
  next_attempt_at: Date;
  succeeded_at: Date | null;
  last_error: string | null;
};

/**
 * Builds a serializer for the notification rows of a hit listing, resolving
 * each row's destination scope in one query so the routes stay two-query.
 */
export async function hitNotificationSerializer(
  rows: Notification[],
  authed: ApiKey,
): Promise<(n: Notification) => SerializedHitNotification> {
  const destIds = [
    ...new Set(
      rows
        .map((r) => r.destinationId)
        .filter((id): id is string => id !== null),
    ),
  ];
  const ownerByDest = new Map<string, string | null>();
  if (destIds.length > 0) {
    const dests = await db
      .select({
        id: notificationDestinations.id,
        keyId: notificationDestinations.keyId,
      })
      .from(notificationDestinations)
      .where(inArray(notificationDestinations.id, destIds));
    for (const d of dests) ownerByDest.set(d.id, d.keyId);
  }

  return (n) => {
    let scope: DestinationScope = "unknown";
    if (n.destinationId !== null && ownerByDest.has(n.destinationId)) {
      scope = ownerByDest.get(n.destinationId) === null ? "global" : "key";
    }
    const visible =
      authed.isAdmin ||
      (scope === "key" && ownerByDest.get(n.destinationId!) === n.keyId);
    return {
      id: n.id,
      channel: n.channel,
      target: visible ? n.target : null,
      destination_scope: scope,
      status: n.status,
      attempts: n.attempts,
      max_attempts: n.maxAttempts,
      next_attempt_at: n.nextAttemptAt,
      succeeded_at: n.succeededAt,
      last_error: n.lastError,
    };
  };
}
