"use server";

import { db } from "@/db/client";
import { keys } from "@/db/schema";
import { newPublicId } from "@/lib/keys";
import { getSessionApiKey } from "@/lib/session";
import { getPreset, isPresetId } from "@/lib/presets";

export type BulkState = {
  error?: string;
  created?: Array<{ id: string; publicId: string; memo: string }>;
  /** Format the client should request from the bulk download endpoint. */
  downloadFormat?: string | null;
  presetId?: string;
};

/** Hard cap per submission — keeps one click from minting a runaway batch. */
const MAX_BULK = 50;

export async function bulkCreateAction(
  _prev: BulkState,
  formData: FormData,
): Promise<BulkState> {
  const session = await getSessionApiKey();
  if (!session) return { error: "not signed in" };

  const presetRaw = String(formData.get("preset") ?? "");
  if (!isPresetId(presetRaw)) return { error: "pick a canary type" };
  const preset = getPreset(presetRaw);

  const namesRaw = String(formData.get("names") ?? "");
  const names = namesRaw
    .split("\n")
    .map((n) => n.trim())
    .filter((n) => n.length > 0);

  if (names.length === 0) return { error: "enter at least one name" };
  if (names.length > MAX_BULK) {
    return { error: `too many at once (max ${MAX_BULK}, got ${names.length})` };
  }
  const tooLong = names.find((n) => n.length > 500);
  if (tooLong) {
    return { error: `name too long (max 500): "${tooLong.slice(0, 40)}…"` };
  }
  // Duplicate memos would produce indistinguishable keys — the exact thing
  // one-key-per-use-case is meant to avoid.
  const dupe = names.find((n, i) => names.indexOf(n) !== i);
  if (dupe) return { error: `duplicate name: "${dupe}"` };

  const rows = names.map((memo) => ({
    publicId: newPublicId(),
    memo,
    responseKind: preset.responseKind,
    responsePayload: null,
    dedupeWindowSeconds: preset.dedupeWindowSeconds,
    createdByApiKeyId: session.id,
  }));

  let inserted;
  try {
    inserted = await db.insert(keys).values(rows).returning();
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : "failed to create keys",
    };
  }

  // No per-key destinations are attached: bulk minting exists to be fast, and
  // global destinations (settings → notifications) already cover the fan-out.
  return {
    created: inserted.map((r) => ({
      id: r.id,
      publicId: r.publicId,
      memo: r.memo,
    })),
    downloadFormat: preset.downloadFormat,
    presetId: preset.id,
  };
}
