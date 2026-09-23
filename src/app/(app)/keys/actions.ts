"use server";

import { eq } from "drizzle-orm";
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/db/client";
import {
  keys,
  type ApiKey,
  type Key,
  type MonitorMode,
  monitorModes,
} from "@/db/schema";
import { audit } from "@/lib/audit";
import { canAccessKey } from "@/lib/auth";
import { clientIpFromHeaders } from "@/lib/request-info";
import { getSessionApiKey } from "@/lib/session";
import { validateDestination } from "@/lib/notify/channels";
import { replaceDestinations, type DestinationInput } from "@/lib/notify/destinations";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function requireSession(): Promise<ApiKey> {
  const s = await getSessionApiKey();
  if (!s) redirect("/login");
  return s;
}

async function loadOwned(session: ApiKey, id: string): Promise<Key | null> {
  if (!UUID_RE.test(id)) return null;
  const [row] = await db.select().from(keys).where(eq(keys.id, id)).limit(1);
  if (!canAccessKey(session, row)) return null;
  return row ?? null;
}

async function actorIp(): Promise<string | null> {
  // Delegate to the shared helper (trust gate + rightmost-hop XFF parsing).
  const h = await headers();
  return clientIpFromHeaders((n) => h.get(n));
}

export async function toggleKeyAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const id = String(formData.get("id") ?? "");
  const disable = formData.get("disable") === "1";
  const owned = await loadOwned(session, id);
  if (!owned) return;

  await db
    .update(keys)
    .set({ disabledAt: disable ? new Date() : null })
    .where(eq(keys.id, id));

  await audit({
    type: disable ? "key.disabled" : "key.enabled",
    actorApiKeyId: session.id,
    actorLabel: session.name,
    subjectKind: "key",
    subjectId: id,
    metadata: { via: "dashboard" },
    ip: await actorIp(),
  });

  revalidatePath("/keys");
  revalidatePath(`/keys/${id}`);
}

export async function deleteKeyAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const id = String(formData.get("id") ?? "");
  const owned = await loadOwned(session, id);
  if (!owned) return;

  await db.delete(keys).where(eq(keys.id, id));

  await audit({
    type: "key.deleted",
    actorApiKeyId: session.id,
    actorLabel: session.name,
    subjectKind: "key",
    subjectId: id,
    metadata: { memo: owned.memo, via: "dashboard" },
    ip: await actorIp(),
  });

  revalidatePath("/keys");
  redirect("/keys");
}

export type MonitorActionState = { error?: string };

export type DestinationsActionState = { error?: string; saved?: boolean };

export async function setDestinationsAction(
  _prev: DestinationsActionState,
  formData: FormData,
): Promise<DestinationsActionState> {
  const session = await requireSession();
  const id = String(formData.get("id") ?? "");
  const key = await loadOwned(session, id);
  if (!key) return { error: "key not found" };

  const count = Number(formData.get("destination_count"));
  if (!Number.isInteger(count) || count < 0 || count > 50) {
    return { error: "use at most 50 destinations" };
  }
  const channels = new Set(["webhook", "email", "slack", "discord", "teams", "home_assistant"]);
  const inputs: DestinationInput[] = [];
  for (let i = 0; i < count; i++) {
    const channel = String(formData.get(`channel_${i}`) ?? "");
    const target = String(formData.get(`target_${i}`) ?? "").trim();
    if (!target) return { error: `destination ${i + 1}: target is required` };
    if (!channels.has(channel)) return { error: `destination ${i + 1}: invalid channel` };
    const checked = validateDestination(channel as DestinationInput["channel"], target);
    if (!checked.ok) return { error: `destination ${i + 1}: ${checked.error}` };
    inputs.push({ channel: channel as DestinationInput["channel"], target });
  }

  try {
    await replaceDestinations(key, inputs);
  } catch {
    return { error: "could not save destinations; your changes are still in the form" };
  }
  revalidatePath(`/keys/${id}`);
  return { saved: true };
}

function isMonitorMode(v: string): v is MonitorMode {
  return (monitorModes as readonly string[]).includes(v);
}

export async function setMonitorAction(
  _prev: MonitorActionState,
  formData: FormData,
): Promise<MonitorActionState> {
  const session = await requireSession();
  const id = String(formData.get("id") ?? "");
  const owned = await loadOwned(session, id);
  if (!owned) return { error: "invalid key id" };

  const modeRaw = String(formData.get("monitor_mode") ?? "");
  if (!isMonitorMode(modeRaw)) {
    return { error: `invalid mode: ${modeRaw}` };
  }

  const windowRaw = String(formData.get("monitor_window_seconds") ?? "300");
  const windowSeconds = Number.parseInt(windowRaw, 10);
  if (
    !Number.isFinite(windowSeconds) ||
    windowSeconds < 30 ||
    windowSeconds > 86_400
  ) {
    return { error: "window must be 30–86400 seconds" };
  }

  await db
    .update(keys)
    .set({
      monitorMode: modeRaw,
      monitorWindowSeconds: windowSeconds,
    })
    .where(eq(keys.id, id));

  revalidatePath(`/keys/${id}`);
  return {};
}

export async function resetMonitorAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const id = String(formData.get("id") ?? "");
  const owned = await loadOwned(session, id);
  if (!owned) return;

  await db
    .update(keys)
    .set({ monitorResetAt: new Date() })
    .where(eq(keys.id, id));

  await audit({
    type: "monitor.reset",
    actorApiKeyId: session.id,
    actorLabel: session.name,
    subjectKind: "key",
    subjectId: id,
    metadata: { via: "dashboard" },
    ip: await actorIp(),
  });

  revalidatePath(`/keys/${id}`);
}
