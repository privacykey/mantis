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
import { getSessionApiKey } from "@/lib/session";

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
  // Trust gate mirrors request-info.ts:extractIp.
  const trust =
    process.env.TRUST_PROXY_HEADERS === "1" ||
    Boolean(process.env.VERCEL) ||
    process.env.NODE_ENV !== "production";
  if (!trust) return null;
  const h = await headers();
  return (
    h.get("cf-connecting-ip") ??
    h.get("x-vercel-forwarded-for") ??
    h.get("x-real-ip") ??
    h.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    null
  );
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
