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
  key: Key,
  destination: NotificationDestination,
): Promise<ActivationResult> {
  try {
    await dispatchActivation(destination.channel as NotificationChannel, {
      key,
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

type ActivationCtx = { key: Key; target: string };

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
    key: {
      id: ctx.key.id,
      public_id: ctx.key.publicId,
      memo: ctx.key.memo,
      url: keyUrl(ctx.key.publicId),
    },
    connected_at: new Date().toISOString(),
    message: "Mantis destination connected. Real hit alerts will arrive at this URL.",
  });
}

async function activateEmail(ctx: ActivationCtx): Promise<void> {
  const m = getMailer();
  if (!m) throw new Error("SMTP_URL not configured");
  await m.sendMail({
    from: env.smtpFrom,
    to: ctx.target,
    subject: `[mantis] connected: ${sanitizeHeaderValue(ctx.key.memo)}`,
    text:
      `Mantis key "${ctx.key.memo}" is now configured to alert this email address.\n\n` +
      `Key URL: ${keyUrl(ctx.key.publicId)}\n\n` +
      `This is a one-time confirmation. Real alerts will look similar but with hit details.`,
  });
}

async function activateSlack(ctx: ActivationCtx): Promise<void> {
  const url = keyUrl(ctx.key.publicId);
  await postJson(ctx.target, {
    text: `Mantis connected: ${ctx.key.memo}`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text:
            `✅ *Mantis connected*: <${url}|${escapeMrkdwn(ctx.key.memo)}>\n` +
            `You'll get an alert here when this key fires.`,
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
        title: `✅ Mantis connected: ${ctx.key.memo}`,
        url: keyUrl(ctx.key.publicId),
        color: 0x10b981, // emerald-500
        description:
          "This webhook is now configured. You'll get an alert here when the key fires.",
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
              text: `✅ Mantis connected: ${ctx.key.memo}`,
              wrap: true,
            },
            {
              type: "TextBlock",
              text: `[Open key in dashboard](${keyUrl(ctx.key.publicId)})`,
              wrap: true,
              isSubtle: true,
              spacing: "Small",
            },
            {
              type: "TextBlock",
              text: "This webhook is now configured. You'll get an alert here when the key fires.",
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
    memo: ctx.key.memo,
    key_url: keyUrl(ctx.key.publicId),
    key_public_id: ctx.key.publicId,
    activation: true,
    connected_at: new Date().toISOString(),
    message:
      "Mantis Home Assistant destination connected. Hit alerts will arrive at this webhook.",
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
