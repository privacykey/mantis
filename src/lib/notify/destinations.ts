import { randomBytes } from "node:crypto";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/db/client";
import {
  keys,
  notificationDestinations,
  type Key,
  type NotificationChannel,
  type NotificationDestination,
} from "@/db/schema";
import { openSecret, sealSecret } from "@/lib/secret-box";
import { fireActivationPing } from "./activation";

export function newSigningSecret(): string {
  return randomBytes(32).toString("base64");
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
  const existing = await listGlobalDestinations();
  const existingByPair = new Map<string, NotificationDestination>(
    existing.map((d) => [`${d.channel}\0${d.target}`, d]),
  );

  await db
    .delete(notificationDestinations)
    .where(isNull(notificationDestinations.keyId));

  const results: DestinationResult[] = [];
  for (const input of inputs) {
    const carry = existingByPair.get(`${input.channel}\0${input.target}`);
    if (carry) {
      const [row] = await db
        .insert(notificationDestinations)
        .values({
          keyId: null,
          channel: carry.channel,
          target: carry.target,
          signingSecret: carry.signingSecret,
          lastActivationStatus: carry.lastActivationStatus,
          lastActivationError: carry.lastActivationError,
          lastActivationAt: carry.lastActivationAt,
        })
        .returning();
      if (row) {
        results.push({
          destination: row,
          activation: {
            ok: carry.lastActivationStatus === "ok",
            error: carry.lastActivationError ?? undefined,
          },
        });
      }
    } else {
      const [row] = await db
        .insert(notificationDestinations)
        .values({
          keyId: null,
          channel: input.channel,
          target: input.target,
          signingSecret:
            input.channel === "webhook" ? sealSecret(newSigningSecret()) : null,
        })
        .returning();
      if (!row) throw new Error("global destination insert returned no row");
      // No key to describe — fireActivationPing handles a null key.
      const activation = await fireActivationPing(null, row);
      const [refreshed] = await db
        .select()
        .from(notificationDestinations)
        .where(eq(notificationDestinations.id, row.id))
        .limit(1);
      results.push({ destination: refreshed ?? row, activation });
    }
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
