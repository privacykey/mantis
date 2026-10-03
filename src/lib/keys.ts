import { createHmac } from "node:crypto";
import { customAlphabet } from "nanoid";
import type { Key, NotificationDestination } from "@/db/schema";
import { env, keyUrl, statusUrl } from "@/lib/env";
import { serializeDestination } from "@/lib/notify/destinations";

const ID_ALPHABET =
  "23456789abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ";

const generate = customAlphabet(ID_ALPHABET, 10);

export function newPublicId(): string {
  return generate();
}

/**
 * Webhook id for a key's Home Assistant receiver. It is the only credential
 * between Mantis and Home Assistant, so it must not be derivable from the key
 * id (which enroll keys, webhook receivers and monitored hosts all see). An
 * HMAC under the server pepper is unguessable and stable, so the downloaded
 * YAML and the registration command shown beside it always carry the same id.
 */
export function homeAssistantWebhookId(keyId: string): string {
  const tag = createHmac("sha256", env.apiKeyPepper)
    .update(`mantis-ha-webhook-v1:${keyId}`)
    .digest("hex")
    .slice(0, 48);
  return `mantis-${tag}`;
}

export function serializeKey(
  k: Key,
  destinations: NotificationDestination[] = [],
) {
  return {
    id: k.id,
    public_id: k.publicId,
    url: keyUrl(k.publicId),
    kind: k.kind,
    memo: k.memo,
    external_id: k.externalId,
    response_kind: k.responseKind,
    response_payload: k.responsePayload,
    destinations: destinations.map((d) => serializeDestination(d)),
    dedupe_window_seconds: k.dedupeWindowSeconds,
    monitor_mode: k.monitorMode,
    monitor_window_seconds: k.monitorWindowSeconds,
    monitor_reset_at: k.monitorResetAt,
    monitor_status_url:
      k.monitorMode === "off" ? null : statusUrl(k.publicId),
    self_origins: k.selfOrigins,
    created_at: k.createdAt,
    disabled_at: k.disabledAt,
    expires_at: k.expiresAt,
    disabled: k.disabledAt !== null,
  };
}

/**
 * Reduced shape for enrollment responses: enough for a device to install its
 * tripwire (the trigger URL + its own identity), nothing about how alerts are
 * routed or monitored.
 *
 * `includeMemo: false` is the cross-key claim: an enrollment-scoped key that
 * did NOT create the key may still recover a machine's trigger URL by serial
 * (fleet re-image / enroll-key rotation — see deploy/kandji), but the memo is
 * another creator's text and is withheld. Unrelated full keys get 409 instead.
 */
export function serializeKeyForEnroll(
  k: Key,
  opts: { includeMemo?: boolean } = {},
) {
  return {
    id: k.id,
    public_id: k.publicId,
    url: keyUrl(k.publicId),
    kind: k.kind,
    memo: opts.includeMemo === false ? null : k.memo,
    external_id: k.externalId,
    created_at: k.createdAt,
    disabled: k.disabledAt !== null,
    expires_at: k.expiresAt,
  };
}
