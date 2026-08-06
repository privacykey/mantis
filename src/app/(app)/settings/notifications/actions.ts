"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { NotificationChannel } from "@/db/schema";
import { getSessionApiKey } from "@/lib/session";
import { validateDestination } from "@/lib/notify/channels";
import {
  replaceGlobalDestinations,
  type DestinationInput,
} from "@/lib/notify/destinations";

export type GlobalDestState = {
  error?: string;
  ok?: boolean;
  /** Per-destination activation outcomes, so a bad URL is visible immediately. */
  results?: Array<{ target: string; ok: boolean; error?: string }>;
};

const VALID_CHANNELS: NotificationChannel[] = [
  "webhook",
  "email",
  "slack",
  "discord",
  "teams",
  "home_assistant",
];

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

  let results;
  try {
    results = await replaceGlobalDestinations(inputs);
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : "failed to save destinations",
    };
  }

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
