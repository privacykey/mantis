import { randomBytes } from "node:crypto";
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { db } from "@/db/client";
import {
  keys,
  notificationDestinations,
  notifications,
  type Key,
  type NotificationChannel,
  type NotificationDestination,
} from "@/db/schema";
import { openSecret, sealSecret } from "@/lib/secret-box";
import { fireActivationPing } from "./activation";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export function newSigningSecret(): string {
  return randomBytes(32).toString("base64");
}

/**
 * Removing a destination withdraws it: deliveries already queued for it (or
 * waiting on a retry) must not go out. Each notification row carries its own
 * copy of the target, so deleting the destination alone would leave them
 * deliverable for the rest of the retry schedule.
 *
 * Must run BEFORE the destination rows are deleted, in the same transaction:
 * notifications.destination_id is ON DELETE SET NULL, so afterwards these rows
 * can no longer be found. Clearing the claim fences a worker that already holds
 * one — its completion writes check status and claim_token. A request that is
 * already on the wire cannot be recalled.
 */
async function abortQueuedDeliveries(tx: Tx, destinationIds: string[]): Promise<void> {
  await tx
    .update(notifications)
    .set({
      status: "aborted",
      lastError: "destination removed before delivery",
      claimToken: null,
      leaseUntil: null,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        inArray(notifications.destinationId, destinationIds),
        // Spelled as an OR so each arm can use its partial index
        // (notifications_pending_idx / notifications_lease_idx).
        or(eq(notifications.status, "pending"), eq(notifications.status, "in_flight")),
      ),
    );
}

/** Returns `first4…last4` — enough to identify a secret without leaking it. */
export function fingerprintSecret(secret: string): string {
  if (secret.length <= 10) return "…";
  return `${secret.slice(0, 4)}…${secret.slice(-4)}`;
}

export type DestinationInput = {
  channel: NotificationChannel;
  target: string;
};

export type DestinationResult = {
  destination: NotificationDestination;
  activation: { ok: boolean; error?: string };
};

/** Commit a new key and its destinations together, then test delivery. */
export function createKeyWithDestinations(
  values: typeof keys.$inferInsert,
  inputs: DestinationInput[],
): Promise<{ key: Key; results: DestinationResult[] }>;
export function createKeyWithDestinations(
  values: typeof keys.$inferInsert,
  inputs: DestinationInput[],
  options: { onExternalIdConflict: true },
): Promise<{ key: Key | null; results: DestinationResult[] }>;
export async function createKeyWithDestinations(
  values: typeof keys.$inferInsert,
  inputs: DestinationInput[],
  options?: { onExternalIdConflict: true },
): Promise<{ key: Key | null; results: DestinationResult[] }> {
  const created = await db.transaction(async (tx) => {
    const insert = tx.insert(keys).values(values);
    const [key] = options?.onExternalIdConflict
      ? await insert.onConflictDoNothing({ target: keys.externalId }).returning()
      : await insert.returning();
    if (!key && options?.onExternalIdConflict) return null;
    if (!key) throw new Error("key insert returned no row");
    const destinations: NotificationDestination[] = [];
    for (const input of inputs) {
      const [destination] = await tx
        .insert(notificationDestinations)
        .values({
          keyId: key.id,
          channel: input.channel,
          target: input.target,
          signingSecret:
            input.channel === "webhook" ? sealSecret(newSigningSecret()) : null,
        })
        .returning();
      if (!destination) throw new Error("destination insert returned no row");
      destinations.push(destination);
    }
    return { key, destinations };
  });
  if (!created) return { key: null, results: [] };

  const results: DestinationResult[] = [];
  for (const destination of created.destinations) {
    let activation: DestinationResult["activation"];
    try {
      activation = await fireActivationPing(created.key, destination);
    } catch (err) {
      activation = {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
    const [refreshed] = await db
      .select()
      .from(notificationDestinations)
      .where(eq(notificationDestinations.id, destination.id))
      .limit(1)
      .catch(() => [destination]);
    results.push({ destination: refreshed ?? destination, activation });
  }
  return { key: created.key, results };
}

/** Inserts a destination + fires an activation ping; persists both. */
export async function createDestination(
  key: Key,
  input: DestinationInput,
): Promise<DestinationResult> {
  const [row] = await db
    .insert(notificationDestinations)
    .values({
      keyId: key.id,
      channel: input.channel,
      target: input.target,
      // Per-destination HMAC secret; only generic webhooks need it. Sealed at
      // rest (no-op unless MANTIS_SECRET_KEY is set).
      signingSecret:
        input.channel === "webhook" ? sealSecret(newSigningSecret()) : null,
    })
    .returning();
  if (!row) throw new Error("destination insert returned no row");

  const activation = await fireActivationPing(key, row);

  const [refreshed] = await db
    .select()
    .from(notificationDestinations)
    .where(eq(notificationDestinations.id, row.id))
    .limit(1);
  return { destination: refreshed ?? row, activation };
}

/**
 * Replaces the full destination set for a key. Existing (channel, target)
 * pairs are carried over verbatim — same row id, same secret, same
 * activation history — so editing one destination doesn't rotate
 * unrelated secrets. New pairs get a fresh secret + ping.
 */
export async function replaceDestinations(
  key: Key,
  inputs: DestinationInput[],
): Promise<DestinationResult[]> {
  const persisted = await db.transaction(async (tx) => {
    const existing = await tx
      .select()
      .from(notificationDestinations)
      .where(eq(notificationDestinations.keyId, key.id));
    const byPair = new Map<string, NotificationDestination[]>();
    for (const row of existing) {
      const pair = `${row.channel}\0${row.target}`;
      byPair.set(pair, [...(byPair.get(pair) ?? []), row]);
    }
    const rows: Array<{ destination: NotificationDestination; carried: boolean }> = [];
    const retained = new Set<string>();
    for (const input of inputs) {
      const pair = `${input.channel}\0${input.target}`;
      const carry = byPair.get(pair)?.shift();
      if (carry) {
        retained.add(carry.id);
        rows.push({ destination: carry, carried: true });
        continue;
      }
      const [destination] = await tx
        .insert(notificationDestinations)
        .values({
          keyId: key.id,
          channel: input.channel,
          target: input.target,
          signingSecret: input.channel === "webhook" ? sealSecret(newSigningSecret()) : null,
        })
        .returning();
      if (!destination) throw new Error("destination insert returned no row");
      rows.push({ destination, carried: false });
    }
    const removed = existing.filter((row) => !retained.has(row.id)).map((row) => row.id);
    if (removed.length > 0) {
      await abortQueuedDeliveries(tx, removed);
      await tx.delete(notificationDestinations).where(inArray(notificationDestinations.id, removed));
    }
    return rows;
  });

  const results: DestinationResult[] = [];
  for (const { destination, carried } of persisted) {
    let activation: DestinationResult["activation"] = {
      ok: destination.lastActivationStatus === "ok",
      error: destination.lastActivationError ?? undefined,
    };
    if (!carried) {
      try {
        activation = await fireActivationPing(key, destination);
      } catch (err) {
        activation = { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    }
    const [refreshed] = await db
      .select()
      .from(notificationDestinations)
      .where(eq(notificationDestinations.id, destination.id))
      .limit(1)
      .catch(() => [destination]);
    results.push({ destination: refreshed ?? destination, activation });
  }
  return results;
}

export async function listDestinations(
  keyId: string,
): Promise<NotificationDestination[]> {
  return db
    .select()
    .from(notificationDestinations)
    .where(eq(notificationDestinations.keyId, keyId));
}

// ---------------------------------------------------------------------------
// Global destinations (keyId IS NULL) — configured once in
// /settings/notifications and added to EVERY key's fan-out, on top of that
// key's own destinations. Lets an operator mint many keys without re-entering
// the same Slack/webhook URL each time.
// ---------------------------------------------------------------------------

export async function listGlobalDestinations(): Promise<
  NotificationDestination[]
> {
  return db
    .select()
    .from(notificationDestinations)
    .where(isNull(notificationDestinations.keyId))
    .orderBy(notificationDestinations.createdAt);
}

/**
 * Replaces the global destination set. Mirrors replaceDestinations: existing
 * (channel, target) pairs are carried over verbatim — same secret, same
 * activation history — so editing one row doesn't rotate another's secret or
 * re-ping a destination that's already known-good.
 */
export async function replaceGlobalDestinations(
  inputs: DestinationInput[],
): Promise<DestinationResult[]> {
  const persisted = await db.transaction(async (tx) => {
    const existing = await tx
      .select()
      .from(notificationDestinations)
      .where(isNull(notificationDestinations.keyId));
    const byPair = new Map<string, NotificationDestination[]>();
    for (const row of existing) {
      const pair = `${row.channel}\0${row.target}`;
      byPair.set(pair, [...(byPair.get(pair) ?? []), row]);
    }
    const rows: Array<{ destination: NotificationDestination; carried: boolean }> = [];
    const retained = new Set<string>();
    for (const input of inputs) {
      const pair = `${input.channel}\0${input.target}`;
      const carry = byPair.get(pair)?.shift();
      if (carry) {
        retained.add(carry.id);
        rows.push({ destination: carry, carried: true });
        continue;
      }
      const [destination] = await tx
        .insert(notificationDestinations)
        .values({
          keyId: null,
          channel: input.channel,
          target: input.target,
          signingSecret:
            input.channel === "webhook" ? sealSecret(newSigningSecret()) : null,
        })
        .returning();
      if (!destination) throw new Error("global destination insert returned no row");
      rows.push({ destination, carried: false });
    }
    const removed = existing.filter((row) => !retained.has(row.id)).map((row) => row.id);
    if (removed.length > 0) {
      await abortQueuedDeliveries(tx, removed);
      await tx.delete(notificationDestinations).where(inArray(notificationDestinations.id, removed));
    }
    return rows;
  });

  const results: DestinationResult[] = [];
  for (const { destination, carried } of persisted) {
    let activation: DestinationResult["activation"] = {
      ok: destination.lastActivationStatus === "ok",
      error: destination.lastActivationError ?? undefined,
    };
    if (!carried) {
      try {
        activation = await fireActivationPing(null, destination);
      } catch (err) {
        activation = { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    }
    const [refreshed] = await db
      .select()
      .from(notificationDestinations)
      .where(eq(notificationDestinations.id, destination.id))
      .limit(1)
      .catch(() => [destination]);
    results.push({ destination: refreshed ?? destination, activation });
  }
  return results;
}

export type SerializeOpts = {
  /** Include the plaintext signing secret. Pass true only on create/rotate responses. */
  reveal?: boolean;
};

export function serializeDestination(
  d: NotificationDestination,
  opts: SerializeOpts = {},
) {
  const plaintextSecret = d.signingSecret ? openSecret(d.signingSecret) : null;
  return {
    id: d.id,
    channel: d.channel,
    target: d.target,
    // Plaintext on create/rotate responses only; reads return the fingerprint.
    signing_secret: plaintextSecret
      ? opts.reveal
        ? plaintextSecret
        : null
      : null,
    signing_secret_fingerprint: plaintextSecret
      ? fingerprintSecret(plaintextSecret)
      : null,
    created_at: d.createdAt,
    last_activation_status: d.lastActivationStatus,
    last_activation_error: d.lastActivationError,
    last_activation_at: d.lastActivationAt,
  };
}

export function serializeResult(r: DestinationResult, opts: SerializeOpts = {}) {
  return {
    ...serializeDestination(r.destination, opts),
    activation: r.activation,
  };
}

/** Rotates a webhook destination's secret. Returns the updated row, or null if not found / not a webhook channel. */
export async function rotateSigningSecret(
  keyId: string,
  destinationId: string,
): Promise<NotificationDestination | null> {
  const [existing] = await db
    .select()
    .from(notificationDestinations)
    .where(
      and(
        eq(notificationDestinations.id, destinationId),
        eq(notificationDestinations.keyId, keyId),
      ),
    )
    .limit(1);
  if (!existing) return null;
  if (existing.channel !== "webhook") return null;

  const [updated] = await db
    .update(notificationDestinations)
    .set({ signingSecret: sealSecret(newSigningSecret()) })
    .where(eq(notificationDestinations.id, destinationId))
    .returning();
  return updated ?? null;
}

// Global webhook destinations sign every key's deliveries, so whoever runs the
// receiver needs the secret too. The per-key reveal/rotate above can never
// match a keyId IS NULL row; these are their global counterparts. Callers must
// be admin-gated and must audit — see settings/notifications/actions.ts.

/** Plaintext signing secret of a GLOBAL webhook destination, or null if there is none. */
export async function getGlobalSigningSecret(
  destinationId: string,
): Promise<string | null> {
  const [row] = await db
    .select()
    .from(notificationDestinations)
    .where(
      and(
        eq(notificationDestinations.id, destinationId),
        isNull(notificationDestinations.keyId),
      ),
    )
    .limit(1);
  if (!row || row.channel !== "webhook" || !row.signingSecret) return null;
  return openSecret(row.signingSecret);
}

/** Rotates a GLOBAL webhook destination's secret. Returns the updated row, or null if not found / not a webhook channel. */
export async function rotateGlobalSigningSecret(
  destinationId: string,
): Promise<NotificationDestination | null> {
  const [updated] = await db
    .update(notificationDestinations)
    .set({ signingSecret: sealSecret(newSigningSecret()) })
    .where(
      and(
        eq(notificationDestinations.id, destinationId),
        isNull(notificationDestinations.keyId),
        eq(notificationDestinations.channel, "webhook"),
      ),
    )
    .returning();
  return updated ?? null;
}
