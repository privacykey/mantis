"use server";

import { redirect } from "next/navigation";
import { db } from "@/db/client";
import { keys, type NotificationChannel, type ResponseKind } from "@/db/schema";
import { getSessionApiKey } from "@/lib/session";
import { newPublicId } from "@/lib/keys";
import { validateDestination } from "@/lib/notify/channels";
import {
  replaceDestinations,
  type DestinationInput,
} from "@/lib/notify/destinations";

export type CreateState = {
  error?: string;
  destinationWarnings?: Array<{ index: number; error: string }>;
};

const VALID_KINDS: ResponseKind[] = ["gif", "empty", "json", "redirect", "html"];
const VALID_CHANNELS: NotificationChannel[] = [
  "webhook",
  "email",
  "slack",
  "discord",
  "teams",
];

export async function createKeyAction(
  _prev: CreateState,
  formData: FormData,
): Promise<CreateState> {
  const session = await getSessionApiKey();
  if (!session) redirect("/login");

  const memo = String(formData.get("memo") ?? "").trim();
  if (!memo) return { error: "memo is required" };
  if (memo.length > 500) return { error: "memo too long (max 500)" };

  const responseKindRaw = String(formData.get("response_kind") ?? "gif");
  const responseKind = (VALID_KINDS as string[]).includes(responseKindRaw)
    ? (responseKindRaw as ResponseKind)
    : "gif";

  let responsePayload: unknown = null;
  if (responseKind === "redirect") {
    const url = String(formData.get("redirect_url") ?? "").trim();
    if (!url) return { error: "redirect URL is required" };
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { error: "redirect URL is malformed" };
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { error: "redirect URL must be http(s)" };
    }
    responsePayload = { url };
  } else if (responseKind === "html") {
    const html = String(formData.get("html_body") ?? "").trim();
    if (!html) return { error: "HTML body is required" };
    if (html.length > 64 * 1024) return { error: "HTML body too long (max 64KB)" };
    responsePayload = { html };
  } else if (responseKind === "json") {
    const raw = String(formData.get("json_body") ?? "").trim();
    if (raw) {
      try {
        responsePayload = JSON.parse(raw);
      } catch {
        return { error: "JSON body is invalid JSON" };
      }
    }
  }

  // Destinations: form fields `destinations[N][channel]` and `destinations[N][target]`,
  // unbounded N. Form posts these via the destinations editor UI.
  const destinations: DestinationInput[] = [];
  const seenIdx = new Set<number>();
  for (const [k] of formData.entries()) {
    const m = /^destinations\[(\d+)\]\[channel\]$/.exec(k);
    if (m) seenIdx.add(Number(m[1]));
  }
  for (const idx of [...seenIdx].sort((a, b) => a - b)) {
    const channelRaw = String(formData.get(`destinations[${idx}][channel]`) ?? "");
    const target = String(formData.get(`destinations[${idx}][target]`) ?? "").trim();
    if (!target) continue; // skip blank rows
    if (!(VALID_CHANNELS as string[]).includes(channelRaw)) {
      return { error: `destination ${idx + 1}: invalid channel` };
    }
    const channel = channelRaw as NotificationChannel;
    const v = validateDestination(channel, target);
    if (!v.ok) {
      return { error: `destination ${idx + 1}: ${v.error}` };
    }
    destinations.push({ channel, target });
  }

  const dedupRaw = String(formData.get("dedupe_window_seconds") ?? "60");
  const dedupeWindowSeconds = Number.parseInt(dedupRaw, 10);
  if (!Number.isFinite(dedupeWindowSeconds) || dedupeWindowSeconds < 0 || dedupeWindowSeconds > 86_400) {
    return { error: "dedupe window must be 0–86400 seconds" };
  }

  const [row] = await db
    .insert(keys)
    .values({
      publicId: newPublicId(),
      memo,
      responseKind,
      responsePayload: responsePayload as object | null,
      dedupeWindowSeconds,
      createdByApiKeyId: session.id,
    })
    .returning();

  if (!row) return { error: "failed to create key" };

  // Fire activation pings in the background — they update the destinations
  // table directly, so failures show up on the detail page rather than
  // blocking the redirect.
  if (destinations.length > 0) {
    await replaceDestinations(row, destinations);
  }

  redirect(`/keys/${row.id}`);
}
