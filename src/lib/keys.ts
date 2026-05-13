import { customAlphabet } from "nanoid";
import type { Key, NotificationDestination } from "@/db/schema";
import { keyUrl, statusUrl } from "@/lib/env";
import { serializeDestination } from "@/lib/notify/destinations";

const ID_ALPHABET =
  "23456789abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ";

const generate = customAlphabet(ID_ALPHABET, 10);

export function newPublicId(): string {
  return generate();
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
    response_kind: k.responseKind,
    response_payload: k.responsePayload,
    destinations: destinations.map((d) => serializeDestination(d)),
    dedupe_window_seconds: k.dedupeWindowSeconds,
    monitor_mode: k.monitorMode,
    monitor_window_seconds: k.monitorWindowSeconds,
    monitor_reset_at: k.monitorResetAt,
    monitor_status_url:
      k.monitorMode === "off" ? null : statusUrl(k.publicId),
    created_at: k.createdAt,
    disabled_at: k.disabledAt,
    expires_at: k.expiresAt,
    disabled: k.disabledAt !== null,
  };
}
