import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "@/db/client";
import {
  notificationDestinations,
  type Key,
  type NotificationChannel,
  type NotificationDestination,
} from "@/db/schema";
import { openSecret, sealSecret } from "@/lib/secret-box";
import { fireActivationPing } from "./activation";
import { validateDestination } from "./channels";

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
  const existing = await db
    .select()
    .from(notificationDestinations)
    .where(eq(notificationDestinations.keyId, key.id));
  const existingByPair = new Map<string, NotificationDestination>(
    existing.map((d) => [`${d.channel}\0${d.target}`, d]),
  );

  await db
    .delete(notificationDestinations)
    .where(eq(notificationDestinations.keyId, key.id));

  if (inputs.length === 0) return [];

  const results: DestinationResult[] = [];
  for (const input of inputs) {
    const carry = existingByPair.get(`${input.channel}\0${input.target}`);
    if (carry) {
      // Carry-over: same secret + activation history, no fresh ping.
      const [row] = await db
        .insert(notificationDestinations)
        .values({
          keyId: key.id,
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
      results.push(await createDestination(key, input));
    }
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

export async function deleteDestination(id: string): Promise<boolean> {
  const rows = await db
    .delete(notificationDestinations)
    .where(eq(notificationDestinations.id, id))
    .returning({ id: notificationDestinations.id });
  return rows.length > 0;
}

/** Validates a batch, returning per-index errors. */
export function validateInputs(
  inputs: DestinationInput[],
): Array<{ index: number; error: string }> {
  const errs: Array<{ index: number; error: string }> = [];
  for (let i = 0; i < inputs.length; i++) {
    const { channel, target } = inputs[i]!;
    const v = validateDestination(channel, target);
    if (!v.ok) errs.push({ index: i, error: v.error });
  }
  return errs;
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
