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
import {
  hasControlChars,
  MAX_SELF_ORIGINS,
  normalizeSelfOrigin,
} from "@/lib/validators";

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

export type MonitorActionState = { error?: string; saved?: boolean };

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
    if (hasControlChars(target)) return { error: `destination ${i + 1}: target must not contain control characters` };
    if (!channels.has(channel)) return { error: `destination ${i + 1}: invalid channel` };
    const checked = validateDestination(channel as DestinationInput["channel"], target);
    if (!checked.ok) return { error: `destination ${i + 1}: ${checked.error}` };
    inputs.push({ channel: channel as DestinationInput["channel"], target });
  }

  let results;
  try {
    results = await replaceDestinations(key, inputs);
  } catch {
    return { error: "could not save destinations; your changes are still in the form" };
  }
  await audit({
    type: "destinations.replaced",
    actorApiKeyId: session.id,
    actorLabel: session.name,
    subjectKind: "key",
    subjectId: id,
    metadata: {
      count: results.length,
      channels: results.map((r) => r.destination.channel),
      via: "dashboard",
    },
    ip: await actorIp(),
  });
  revalidatePath(`/keys/${id}`);
  return { saved: true };
}

export type SelfOriginsActionState = { error?: string; saved?: boolean };

export async function setSelfOriginsAction(
  _prev: SelfOriginsActionState,
  formData: FormData,
): Promise<SelfOriginsActionState> {
  const session = await requireSession();
  const id = String(formData.get("id") ?? "");
  const key = await loadOwned(session, id);
  if (!key) return { error: "key not found" };

  const lines = String(formData.get("self_origins") ?? "")
    .split(/[\s,]+/)
    .filter(Boolean);
  if (lines.length > MAX_SELF_ORIGINS) {
    return { error: `use at most ${MAX_SELF_ORIGINS} origins` };
  }
  const origins: string[] = [];
  for (const line of lines) {
    const origin = normalizeSelfOrigin(line);
    if (!origin) {
      return { error: `not a site origin (expected something like https://www.example.com): ${line.slice(0, 80)}` };
    }
    if (!origins.includes(origin)) origins.push(origin);
  }

  try {
    await db.update(keys).set({ selfOrigins: origins }).where(eq(keys.id, id));
  } catch {
    return { error: "could not save origins; your changes are still in the form" };
  }
  await audit({
    type: "key.updated",
    actorApiKeyId: session.id,
    actorLabel: session.name,
    subjectKind: "key",
    subjectId: id,
    metadata: { fields: ["selfOrigins"], via: "dashboard" },
    ip: await actorIp(),
  });
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
  let session;
  try { session = await getSessionApiKey(); } catch {
    return { error: "could not verify your session; your changes are still in the form" };
  }
  if (!session) return { error: "session expired; sign in in another tab, then save again" };
  const id = String(formData.get("id") ?? "");
  let owned;
  try {
    owned = await loadOwned(session, id);
  } catch {
    return { error: "could not load monitor settings; your changes are still in the form" };
  }
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

  try {
    await db.update(keys).set({ monitorMode: modeRaw, monitorWindowSeconds: windowSeconds }).where(eq(keys.id, id));
  } catch {
    return { error: "could not save monitor settings; your changes are still in the form" };
  }

  await audit({
    type: "key.updated",
    actorApiKeyId: session.id,
    actorLabel: session.name,
    subjectKind: "key",
    subjectId: id,
    metadata: {
      fields: ["monitorMode", "monitorWindowSeconds"],
      monitor_mode: modeRaw,
      via: "dashboard",
    },
    ip: await actorIp(),
  });

  revalidatePath(`/keys/${id}`);
  return { saved: true };
}

export async function resetMonitorAction(_prev: MonitorActionState, formData: FormData): Promise<MonitorActionState> {
  let session;
  try { session = await getSessionApiKey(); } catch {
    return { error: "could not verify your session; try again when the server is available" };
  }
  if (!session) return { error: "session expired; sign in again" };
  const id = String(formData.get("id") ?? "");
  let owned;
  try { owned = await loadOwned(session, id); } catch {
    return { error: "could not load monitor; try again when the server is available" };
  }
  if (!owned) return { error: "invalid key id" };

  try {
    await db.update(keys).set({ monitorResetAt: new Date() }).where(eq(keys.id, id));
  } catch {
    return { error: "could not reset monitor; try again when the server is available" };
  }

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
  return { saved: true };
}
