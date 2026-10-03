"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import type { NotificationChannel } from "@/db/schema";
import { audit } from "@/lib/audit";
import { clientIpFromHeaders } from "@/lib/request-info";
import { getSessionApiKey } from "@/lib/session";
import { validateDestination } from "@/lib/notify/channels";
import {
  fingerprintSecret,
  getGlobalSigningSecret,
  listGlobalDestinations,
  replaceGlobalDestinations,
  rotateGlobalSigningSecret,
  type DestinationInput,
} from "@/lib/notify/destinations";
import { openSecret } from "@/lib/secret-box";

export type GlobalDestState = {
  error?: string;
  ok?: boolean;
  /** Per-destination activation outcomes, so a bad URL is visible immediately. */
  results?: Array<{ target: string; ok: boolean; error?: string }>;
};

/** Result of revealing or rotating a global webhook's signing secret. */
export type GlobalSecretResult =
  | { signing_secret: string; signing_secret_fingerprint: string }
  | { error: string };

const VALID_CHANNELS: NotificationChannel[] = [
  "webhook",
  "email",
  "slack",
  "discord",
  "teams",
  "home_assistant",
];

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function actorIp(): Promise<string | null> {
  // Delegate to the shared helper (trust gate + rightmost-hop XFF parsing).
  const h = await headers();
  return clientIpFromHeaders((n) => h.get(n));
}

export async function saveGlobalDestinationsAction(
  _prev: GlobalDestState,
  formData: FormData,
): Promise<GlobalDestState> {
  const session = await getSessionApiKey();
  if (!session) redirect("/login");
  // Global destinations affect every key in the instance, so gate on admin —
  // matching the wallet settings page.
  if (!session.isAdmin) return { error: "admin only" };

  const inputs: DestinationInput[] = [];
  const seen = new Set<number>();
  for (const [k] of formData.entries()) {
    const m = /^destinations\[(\d+)\]\[channel\]$/.exec(k);
    if (m) seen.add(Number(m[1]));
  }

  const pairs = new Set<string>();
  for (const idx of [...seen].sort((a, b) => a - b)) {
    const channelRaw = String(
      formData.get(`destinations[${idx}][channel]`) ?? "",
    );
    const target = String(
      formData.get(`destinations[${idx}][target]`) ?? "",
    ).trim();
    if (!target) continue; // blank row = removed
    if (!(VALID_CHANNELS as string[]).includes(channelRaw)) {
      return { error: `destination ${idx + 1}: invalid channel` };
    }
    const channel = channelRaw as NotificationChannel;
    const v = validateDestination(channel, target);
    if (!v.ok) return { error: `destination ${idx + 1}: ${v.error}` };
    // Same pair twice would double every alert.
    const pair = `${channel}\0${target}`;
    if (pairs.has(pair)) {
      return { error: `destination ${idx + 1}: duplicate of an earlier row` };
    }
    pairs.add(pair);
    inputs.push({ channel, target });
  }

  let previousIds: Set<string>;
  let results;
  try {
    previousIds = new Set((await listGlobalDestinations()).map((d) => d.id));
    results = await replaceGlobalDestinations(inputs);
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : "failed to save destinations",
    };
  }

  // This set receives every key's hits, so replacing it can silence or
  // redirect alerting for the whole instance. Counts and channels only: the
  // targets are webhook credentials and do not belong in the audit log.
  const currentIds = new Set(results.map((r) => r.destination.id));
  await audit({
    type: "global_destinations.replaced",
    actorApiKeyId: session.id,
    actorLabel: session.name,
    subjectKind: "global_destinations",
    subjectId: "global",
    metadata: {
      count: results.length,
      channels: results.map((r) => r.destination.channel),
      added: [...currentIds].filter((id) => !previousIds.has(id)).length,
      removed: [...previousIds].filter((id) => !currentIds.has(id)).length,
      via: "dashboard",
    },
    ip: await actorIp(),
  });

  revalidatePath("/settings/notifications");
  return {
    ok: true,
    results: results.map((r) => ({
      target: r.destination.target,
      ok: r.activation.ok,
      error: r.activation.error,
    })),
  };
}

/**
 * Returns the plaintext signing secret of a global webhook destination. The
 * per-key reveal route can never match a global row, so without this the
 * receiver of every key's alerts could not verify X-Mantis-Signature at all.
 * Admin only; each reveal is audited.
 */
export async function revealGlobalSigningSecretAction(
  destinationId: string,
): Promise<GlobalSecretResult> {
  const session = await getSessionApiKey();
  if (!session) redirect("/login");
  if (!session.isAdmin) return { error: "admin only" };
  if (typeof destinationId !== "string" || !UUID_RE.test(destinationId)) {
    return { error: "not_found" };
  }

  const secret = await getGlobalSigningSecret(destinationId);
  if (!secret) return { error: "not_found" };

  await audit({
    type: "destination.secret_revealed",
    actorApiKeyId: session.id,
    actorLabel: session.name,
    subjectKind: "destination",
    subjectId: destinationId,
    metadata: { scope: "global", channel: "webhook" },
    ip: await actorIp(),
  });

  return {
    signing_secret: secret,
    signing_secret_fingerprint: fingerprintSecret(secret),
  };
}

/**
 * Rotates a global webhook destination's signing secret and returns the new
 * plaintext. Deliveries already queued keep the previous secret (denormalized
 * at enqueue). Admin only; audited.
 */
export async function rotateGlobalSigningSecretAction(
  destinationId: string,
): Promise<GlobalSecretResult> {
  const session = await getSessionApiKey();
  if (!session) redirect("/login");
  if (!session.isAdmin) return { error: "admin only" };
  if (typeof destinationId !== "string" || !UUID_RE.test(destinationId)) {
    return { error: "not_found" };
  }

  const updated = await rotateGlobalSigningSecret(destinationId);
  if (!updated?.signingSecret) return { error: "not_found" };

  await audit({
    type: "destinations.replaced",
    actorApiKeyId: session.id,
    actorLabel: session.name,
    subjectKind: "destination",
    subjectId: destinationId,
    metadata: { scope: "global", action: "rotate_signing_secret" },
    ip: await actorIp(),
  });

  revalidatePath("/settings/notifications");
  const secret = openSecret(updated.signingSecret);
  return {
    signing_secret: secret,
    signing_secret_fingerprint: fingerprintSecret(secret),
  };
}
