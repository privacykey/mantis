import nodemailer, { type Transporter } from "nodemailer";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db/client";
import {
  notificationDestinations,
  type Key,
  type NotificationChannel,
  type NotificationDestination,
} from "@/db/schema";
import { env, keyUrl } from "@/lib/env";
import { log } from "@/lib/log";
import { sanitizeHeaderValue } from "@/lib/sanitize";
import { safePostJson } from "./safe-post";

let mailer: Transporter | null | undefined;
function getMailer(): Transporter | null {
  if (mailer !== undefined) return mailer;
  if (!env.smtpUrl) {
    mailer = null;
    return null;
  }
  mailer = nodemailer.createTransport(env.smtpUrl);
  return mailer;
}

export type ActivationResult = {
  ok: boolean;
  error?: string;
};

/**
 * Sends a one-shot "this destination is connected" message and records the
 * outcome on the destination row. Synchronous — bypasses the retry queue —
 * because we want immediate feedback in the API response.
 *
 * Best-effort: failure does NOT throw. The destination row is kept, the
 * caller surfaces the error in the API response, and the operator can fix
 * the URL and re-trigger via PATCH.
 */
export async function fireActivationPing(
  key: Key | null,
  destination: NotificationDestination,
): Promise<ActivationResult> {
  try {
    await dispatchActivation(destination.channel as NotificationChannel, {
      // A global destination (keyId NULL) has no key to describe, so the ping
      // announces the destination itself instead.
      label: key ? key.memo : "global destination",
      url: key ? keyUrl(key.publicId) : env.publicBaseUrl,
      keyId: key?.id ?? null,
      publicId: key?.publicId ?? null,
      target: destination.target,
    });
    await persistActivationStatus(destination.id, "ok", null);
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await persistActivationStatus(destination.id, "failed", msg.slice(0, 500));
    log.warn(
      { destinationId: destination.id, channel: destination.channel, err: msg },
      "activation ping failed",
    );
    return { ok: false, error: msg };
  }
}

async function persistActivationStatus(
  id: string,
  status: "ok" | "failed",
  error: string | null,
): Promise<void> {
  await db
    .update(notificationDestinations)
    .set({
      lastActivationStatus: status,
      lastActivationError: error,
      lastActivationAt: sql`now()`,
    })
    .where(eq(notificationDestinations.id, id));
}

// ---------------------------------------------------------------------------
// Per-channel activation message bodies. Simpler than the hit messages —
// just "X is now connected; you'll see real alerts in this channel."
// ---------------------------------------------------------------------------

type ActivationCtx = {
  /** Human label for what was connected — a key's memo, or "global destination". */
  label: string;
  /** Key trigger URL, or the dashboard base URL for a global destination. */
  url: string;
  keyId: string | null;
  publicId: string | null;
  target: string;
};

/** Global destinations have no key, so say so rather than naming one. */
function scopeNote(ctx: ActivationCtx): string {
  return ctx.keyId === null
    ? "This is a GLOBAL destination — it will receive alerts from every mantis key."
    : "You'll get an alert here when this key fires.";
}

async function dispatchActivation(
  channel: NotificationChannel,
  ctx: ActivationCtx,
): Promise<void> {
  switch (channel) {
    case "webhook":
      return activateWebhook(ctx);
    case "email":
      return activateEmail(ctx);
    case "slack":
      return activateSlack(ctx);
    case "discord":
      return activateDiscord(ctx);
    case "teams":
      return activateTeams(ctx);
    case "home_assistant":
      return activateHomeAssistant(ctx);
    default:
      throw new Error(`unknown channel: ${String(channel)}`);
  }
}

async function activateWebhook(ctx: ActivationCtx): Promise<void> {
  await postJson(ctx.target, {
    type: "mantis.activation",
    scope: ctx.keyId === null ? "global" : "key",
    key:
      ctx.keyId === null
        ? null
        : {
            id: ctx.keyId,
            public_id: ctx.publicId,
            memo: ctx.label,
            url: ctx.url,
          },
    connected_at: new Date().toISOString(),
    message: `Mantis destination connected. ${scopeNote(ctx)}`,
  });
}

async function activateEmail(ctx: ActivationCtx): Promise<void> {
  const m = getMailer();
  if (!m) throw new Error("SMTP_URL not configured");
  await m.sendMail({
    from: env.smtpFrom,
    to: ctx.target,
    subject: `[mantis] connected: ${sanitizeHeaderValue(ctx.label)}`,
    text:
      `Mantis "${ctx.label}" is now configured to alert this email address.\n\n` +
      `${scopeNote(ctx)}\n\n` +
      `URL: ${ctx.url}\n\n` +
      `This is a one-time confirmation. Real alerts will look similar but with hit details.`,
  });
}

async function activateSlack(ctx: ActivationCtx): Promise<void> {
  await postJson(ctx.target, {
    text: `Mantis connected: ${ctx.label}`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text:
            `✅ *Mantis connected*: <${ctx.url}|${escapeMrkdwn(ctx.label)}>\n` +
            scopeNote(ctx),
        },
      },
    ],
  });
}

async function activateDiscord(ctx: ActivationCtx): Promise<void> {
  await postJson(ctx.target, {
    username: "mantis",
    embeds: [
      {
        title: `✅ Mantis connected: ${ctx.label}`,
        url: ctx.url,
        color: 0x10b981, // emerald-500
        description: scopeNote(ctx),
        timestamp: new Date().toISOString(),
      },
    ],
  });
}

async function activateTeams(ctx: ActivationCtx): Promise<void> {
  await postJson(ctx.target, {
    type: "message",
    attachments: [
      {
        contentType: "application/vnd.microsoft.card.adaptive",
        content: {
          $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
          type: "AdaptiveCard",
          version: "1.4",
          body: [
            {
              type: "TextBlock",
              size: "Medium",
              weight: "Bolder",
              text: `✅ Mantis connected: ${ctx.label}`,
              wrap: true,
            },
            {
              type: "TextBlock",
              text: `[Open in dashboard](${ctx.url})`,
              wrap: true,
              isSubtle: true,
              spacing: "Small",
            },
            {
              type: "TextBlock",
              text: `This webhook is now configured. ${scopeNote(ctx)}`,
              wrap: true,
              spacing: "Small",
            },
          ],
        },
      },
    ],
  });
}

async function activateHomeAssistant(ctx: ActivationCtx): Promise<void> {
  await postJson(ctx.target, {
    type: "mantis.activation",
    scope: ctx.keyId === null ? "global" : "key",
    memo: ctx.label,
    key_url: ctx.url,
    key_public_id: ctx.publicId,
    activation: true,
    connected_at: new Date().toISOString(),
    message: `Mantis Home Assistant destination connected. ${scopeNote(ctx)}`,
  });
}

async function postJson(url: string, body: unknown): Promise<void> {
  // No body echo — activation errors surface via the API, so we can't let
  // them carry response-body previews from arbitrary URLs the caller chose.
  await safePostJson(url, body, { userAgent: "mantis-activation/0.13" });
}

function escapeMrkdwn(s: string): string {
  return s.replace(/[<>&]/g, (c) =>
    c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&amp;",
  );
}
