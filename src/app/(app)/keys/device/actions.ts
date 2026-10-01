"use server";

import { inArray } from "drizzle-orm";
import { db } from "@/db/client";
import { keys } from "@/db/schema";
import {
  deviceExternalId,
  deviceMemo,
  deviceNameError,
  getDeviceProfile,
  isDeviceOs,
  type DeviceOs,
} from "@mantis/core/device-profiles";
import { newPublicId } from "@/lib/keys";
import { getSessionApiKey } from "@/lib/session";

export type DeviceState = {
  error?: string;
  device?: string;
  os?: DeviceOs;
  /** One entry per selected vector, in profile order. */
  minted?: Array<{
    id: string;
    publicId: string;
    memo: string;
    slug: string;
    /** False when the key already existed and was reused. */
    created: boolean;
  }>;
};

export async function deviceCreateAction(
  _prev: DeviceState,
  formData: FormData,
): Promise<DeviceState> {
  const session = await getSessionApiKey();
  if (!session) return { error: "not signed in" };

  const osRaw = String(formData.get("os") ?? "");
  if (!isDeviceOs(osRaw)) return { error: "pick an operating system" };
  const os = osRaw;

  const device = String(formData.get("device") ?? "").trim();
  const nameErr = deviceNameError(device);
  if (nameErr) return { error: nameErr, os };

  const slugs = formData.getAll("vectors").map(String);
  if (slugs.length === 0) return { error: "pick at least one alarm", os, device };

  const profile = getDeviceProfile(os);
  // Iterate the profile rather than the submitted list so the result is always
  // in a stable, meaningful order and an unknown slug can't slip through.
  const chosen = profile.vectors.filter((v) => slugs.includes(v.slug));
  if (chosen.length !== slugs.length) {
    return { error: "unknown alarm selected", os, device };
  }

  const externalIds = chosen.map((v) => deviceExternalId(device, os, v));
  const rows = chosen.map((v, i) => ({
    publicId: newPublicId(),
    memo: deviceMemo(device, v),
    externalId: externalIds[i]!,
    responseKind: v.responseKind,
    responsePayload: null,
    dedupeWindowSeconds: v.dedupeWindowSeconds,
    createdByApiKeyId: session.id,
  }));

  // Ownership validation shares the insert transaction: a conflict on any
  // vector must roll back the newly inserted vectors in the same suite.
  try {
    const minted = await db.transaction(async (tx) => {
      const inserted = await tx
        .insert(keys)
        .values(rows)
        .onConflictDoNothing({ target: keys.externalId })
        .returning();
      const insertedIds = new Set(inserted.map((r) => r.id));
      const found = await tx.select().from(keys).where(inArray(keys.externalId, externalIds));
      const byExternalId = new Map(found.map((row) => [row.externalId!, row]));
      return chosen.map((vector, i) => {
        const row = byExternalId.get(externalIds[i]!);
        if (!row || row.createdByApiKeyId !== session.id) {
          throw new Error(`"${device}" is already in use by another account on this instance — pick a different device name.`);
        }
        return {
          id: row.id, publicId: row.publicId, memo: row.memo,
          slug: vector.slug, created: insertedIds.has(row.id),
        };
      });
    });
    return { device, os, minted };
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : "failed to create keys",
      os,
      device,
    };
  }
}
