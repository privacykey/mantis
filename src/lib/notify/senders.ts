import nodemailer, { type Transporter } from "nodemailer";
import { db } from "@/db/client";
import {
  hits,
  keys,
  type Hit,
  type Key,
  type NotificationChannel,
} from "@/db/schema";
import { eq } from "drizzle-orm";
import { env, keyDashboardUrl, keyUrl } from "@/lib/env";
import { parseHostContext } from "@/lib/installers/headers";
import { log } from "@/lib/log";
import { sanitizeHeaderValue } from "@/lib/sanitize";
import { clipEscaped, escapeCode, escapeMarkdown, escapeSlack, truncate } from "./escape";
import { safePostJson } from "./safe-post";
import { boundedSmtpUrl } from "./smtp";

let mailer: Transporter | null | undefined;
function getMailer(): Transporter | null {
  if (mailer !== undefined) return mailer;
  if (!env.smtpUrl) {
    mailer = null;
    return null;
  }
  mailer = nodemailer.createTransport(boundedSmtpUrl(env.smtpUrl));
  return mailer;
}

export type SendContext = {
  key: Key;
  hit: Hit;
  target: string;
  /** Per-destination HMAC secret. Webhook body is signed with X-Mantis-Signature when set. */
  signingSecret?: string | null;
  /** Stable across retries; receivers can deduplicate uncertain delivery outcomes. */
  deliveryId?: string;
};

export async function loadSendContext(
  hitId: string,
): Promise<{ key: Key; hit: Hit } | null> {
  const [row] = await db
    .select({ hit: hits, key: keys })
    .from(hits)
    .innerJoin(keys, eq(keys.id, hits.keyId))
    .where(eq(hits.id, hitId))
    .limit(1);
  if (!row) return null;
  return row;
}

// ---------------------------------------------------------------------------
// Channel dispatcher
// ---------------------------------------------------------------------------

export async function send(
  channel: NotificationChannel,
  ctx: SendContext,
): Promise<void> {
  switch (channel) {
    case "webhook":
      return sendWebhook(ctx);
    case "email":
      return sendEmail(ctx);
    case "slack":
      return sendSlack(ctx);
    case "discord":
      return sendDiscord(ctx);
    case "teams":
      return sendTeams(ctx);
    case "home_assistant":
      return sendHomeAssistant(ctx);
    default:
      throw new Error(`unknown channel: ${String(channel)}`);
  }
}

// ---------------------------------------------------------------------------
// Webhook (raw JSON)
// ---------------------------------------------------------------------------

export async function sendWebhook(ctx: SendContext): Promise<void> {
  await postJson(ctx.target, buildPayload(ctx), {
    signingSecret: ctx.signingSecret ?? null,
    deliveryId: ctx.deliveryId,
  });
}

// ---------------------------------------------------------------------------
// Email
// ---------------------------------------------------------------------------

export async function sendEmail(ctx: SendContext): Promise<void> {
  const m = getMailer();
  if (!m) throw new Error("SMTP_URL not configured");
  await m.sendMail({
    from: env.smtpFrom,
    to: ctx.target,
    subject: `[mantis] ${sanitizeHeaderValue(ctx.key.memo)}`,
    text: buildEmailText(ctx),
    ...(ctx.deliveryId ? { messageId: `<${ctx.deliveryId}@mantis.invalid>` } : {}),
  });
}

// ---------------------------------------------------------------------------
// Slack — incoming webhook, blocks-based message
// ---------------------------------------------------------------------------

export async function sendSlack(ctx: SendContext): Promise<void> {
  const { key, hit } = ctx;
  const hostCtx = parseHostContext(hit.headers as Record<string, string> | null);
  const field = (label: string, value: string) =>
    ({ type: "mrkdwn", text: `*${label}*\n${value}` }) as const;
  const slack = (s: string, max: number) => clipEscaped(s, max, escapeSlack);

  // The Referer goes before the optional host-context fields so Slack's
  // 10-field cap can never drop it.
  const fields: Array<{ type: "mrkdwn"; text: string }> = [
    field("IP", slack(hit.ip ?? "—", VALUE_MAX)),
    field("UA", slack(hit.userAgent ?? "—", 80)),
  ];
  if (hit.referer) fields.push(field("Referer", slack(hit.referer, REFERER_MAX)));
  if (hostCtx?.user) fields.push(field("User", slack(hostCtx.user, VALUE_MAX)));
  if (hostCtx?.host) fields.push(field("Host", slack(hostCtx.host, VALUE_MAX)));
  if (hostCtx?.ssh_client_ip) {
    fields.push(field("SSH from", slack(hostCtx.ssh_client_ip, VALUE_MAX)));
  }
  if (hostCtx?.sudo_cmd) {
    const cmd = clipEscaped(hostCtx.sudo_cmd, SUDO_CMD_MAX, (s) => escapeCode(escapeSlack(s)));
    fields.push(field("Sudo cmd", `\`${cmd}\``));
  }

  await postJson(ctx.target, {
    // top-level `text` is the notification fallback; plain_text header is literal.
    text: `Mantis triggered: ${escapeSlack(key.memo)}`,
    blocks: [
      {
        type: "header",
        // Slack rejects a header over 150 characters.
        text: { type: "plain_text", text: truncate(`🪤 ${key.memo}`, 150), emoji: true },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          // Links the dashboard, never keyUrl(): following that fires the canary.
          text: `<${keyDashboardUrl(key.id)}|Open key in dashboard> · key \`${key.publicId}\` · ${hit.occurredAt.toISOString()}`,
        },
      },
      { type: "section", fields: fields.slice(0, 10) },
    ],
  }, { deliveryId: ctx.deliveryId });
}

// ---------------------------------------------------------------------------
// Discord — incoming webhook, embed message
// ---------------------------------------------------------------------------

export async function sendDiscord(ctx: SendContext): Promise<void> {
  const { key, hit } = ctx;
  const hostCtx = parseHostContext(hit.headers as Record<string, string> | null);
  const md = (s: string, max: number) => clipEscaped(s, max, escapeMarkdown);

  const fields: Array<{ name: string; value: string; inline?: boolean }> = [
    { name: "IP", value: md(hit.ip ?? "—", VALUE_MAX), inline: true },
    { name: "UA", value: md(hit.userAgent ?? "—", 80), inline: false },
  ];
  if (hit.referer) {
    fields.push({ name: "Referer", value: md(hit.referer, REFERER_MAX), inline: false });
  }
  if (hostCtx?.user) fields.push({ name: "User", value: md(hostCtx.user, VALUE_MAX), inline: true });
  if (hostCtx?.host) fields.push({ name: "Host", value: md(hostCtx.host, VALUE_MAX), inline: true });
  if (hostCtx?.ssh_client_ip) {
    fields.push({ name: "SSH from", value: md(hostCtx.ssh_client_ip, VALUE_MAX), inline: true });
  }
  if (hostCtx?.sudo_cmd) {
    fields.push({
      name: "Sudo cmd",
      value: "`" + clipEscaped(hostCtx.sudo_cmd, SUDO_CMD_MAX, escapeCode) + "`",
      inline: false,
    });
  }

  await postJson(ctx.target, {
    username: "mantis",
    embeds: [
      {
        // Discord rejects a title over 256 characters.
        title: truncate(`Mantis triggered: ${key.memo}`, 256),
        // The title links the dashboard, never keyUrl(): following that fires the canary.
        url: keyDashboardUrl(key.id),
        color: 0xef4444, // red-500
        timestamp: hit.occurredAt.toISOString(),
        fields: fields.slice(0, 25),
      },
    ],
  }, { deliveryId: ctx.deliveryId });
}

// ---------------------------------------------------------------------------
// Teams — Adaptive Card (Power Automate workflow webhook format)
// ---------------------------------------------------------------------------

export async function sendTeams(ctx: SendContext): Promise<void> {
  const { key, hit } = ctx;
  const hostCtx = parseHostContext(hit.headers as Record<string, string> | null);
  const md = (s: string, max: number) => clipEscaped(s, max, escapeMarkdown);

  const facts: Array<{ title: string; value: string }> = [
    { title: "IP", value: md(hit.ip ?? "—", VALUE_MAX) },
    { title: "Occurred", value: hit.occurredAt.toISOString() },
    { title: "UA", value: md(hit.userAgent ?? "—", 120) },
  ];
  if (hit.referer) facts.push({ title: "Referer", value: md(hit.referer, REFERER_MAX) });
  if (hostCtx?.user) facts.push({ title: "User", value: md(hostCtx.user, VALUE_MAX) });
  if (hostCtx?.host) facts.push({ title: "Host", value: md(hostCtx.host, VALUE_MAX) });
  if (hostCtx?.ssh_client_ip) {
    facts.push({ title: "SSH from", value: md(hostCtx.ssh_client_ip, VALUE_MAX) });
  }
  if (hostCtx?.sudo_cmd) {
    facts.push({ title: "Sudo cmd", value: md(hostCtx.sudo_cmd, VALUE_MAX) });
  }

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
              text: `Mantis triggered: ${escapeMarkdown(key.memo)}`,
              wrap: true,
            },
            {
              type: "TextBlock",
              // The dashboard page, never keyUrl(): following that fires the canary.
              text: `[Open key in dashboard](${keyDashboardUrl(key.id)})`,
              wrap: true,
              isSubtle: true,
              spacing: "Small",
            },
            { type: "FactSet", facts },
          ],
        },
      },
    ],
  }, { deliveryId: ctx.deliveryId });
}

// ---------------------------------------------------------------------------
// Home Assistant — POSTs to a webhook automation trigger
// (https://<ha>/api/webhook/<id>). The webhook_id is the credential; HA
// runs whatever automation the user wired to it. Payload is kept flat so
// HA Jinja templates (`trigger.json.<field>`) stay readable.
// ---------------------------------------------------------------------------

export async function sendHomeAssistant(ctx: SendContext): Promise<void> {
  const { key, hit } = ctx;
  const hostCtx = parseHostContext(hit.headers as Record<string, string> | null);
  await postJson(
    ctx.target,
    {
      type: "mantis.hit",
      memo: key.memo,
      // Machine data: key_url is the TRIGGER URL (fetching it fires the
      // canary). Link dashboard_url in anything a person may follow.
      key_url: keyUrl(key.publicId),
      dashboard_url: keyDashboardUrl(key.id),
      key_public_id: key.publicId,
      occurred_at: hit.occurredAt,
      ip: hit.ip,
      user_agent: hit.userAgent,
      referer: hit.referer,
      ua_browser: hit.uaBrowser,
      ua_os: hit.uaOs,
      ua_device: hit.uaDevice,
      bot_label: hit.botLabel,
      is_duplicate: hit.isDuplicate,
      host_context: hostCtx,
      hit_id: hit.id,
    },
    { signingSecret: ctx.signingSecret ?? null, deliveryId: ctx.deliveryId },
  );
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function postJson(
  url: string,
  body: unknown,
  opts: { signingSecret?: string | null; deliveryId?: string } = {},
): Promise<void> {
  await safePostJson(url, body, {
    signingSecret: opts.signingSecret,
    deliveryId: opts.deliveryId,
    userAgent: "mantis-webhook/0.13",
  });
}

// Post-escape budgets for anonymous-controlled values in the chat formatters
// (IP, User-Agent, Referer, X-Mantis-* host context). Anyone who can reach the
// trigger URL chooses these, up to 16 KiB each, and Slack (2000 characters per
// field) and Discord (1024 per field value, 6000 per embed) reject the WHOLE
// alert over one oversized field. The budgets sit far below those limits; the
// full values stay on the hit in the dashboard.
const VALUE_MAX = 256;
const REFERER_MAX = 120;
const SUDO_CMD_MAX = 120;

function buildPayload({ key, hit, deliveryId }: SendContext) {
  return {
    type: "mantis.hit",
    ...(deliveryId ? { delivery_id: deliveryId } : {}),
    key: {
      id: key.id,
      public_id: key.publicId,
      memo: key.memo,
      // Machine data: `url` is the TRIGGER URL (fetching it fires the canary).
      // Link `dashboard_url` in anything a person may follow.
      url: keyUrl(key.publicId),
      dashboard_url: keyDashboardUrl(key.id),
    },
    hit: {
      id: hit.id,
      occurred_at: hit.occurredAt,
      ip: hit.ip,
      user_agent: hit.userAgent,
      referer: hit.referer,
      ua_browser: hit.uaBrowser,
      ua_os: hit.uaOs,
      ua_device: hit.uaDevice,
      bot_label: hit.botLabel,
      is_duplicate: hit.isDuplicate,
      host_context: parseHostContext(
        hit.headers as Record<string, string> | null,
      ),
      headers: hit.headers,
    },
  };
}

function buildEmailText({ key, hit }: SendContext): string {
  const ctx = parseHostContext(hit.headers as Record<string, string> | null);
  const lines = [
    `Mantis triggered: ${key.memo}`,
    "",
    // Mail clients auto-link (and scanners pre-fetch) any URL in the body, so
    // the trigger URL is never printed: only the dashboard link and the id.
    `Dashboard: ${keyDashboardUrl(key.id)}`,
    `Key:       ${key.publicId} (trigger URL not shown: opening it fires the canary)`,
    `Occurred:  ${hit.occurredAt.toISOString()}`,
    `IP:        ${hit.ip ?? "-"}`,
  ];
  if (ctx) {
    lines.push("");
    lines.push("Host event:");
    if (ctx.source) lines.push(`  Source:       ${ctx.source}`);
    if (ctx.user) lines.push(`  User:         ${ctx.user}`);
    if (ctx.host) lines.push(`  Host:         ${ctx.host}`);
    if (ctx.ssh_client_ip)
      lines.push(`  SSH client:   ${ctx.ssh_client_ip}`);
    if (ctx.ssh_connection)
      lines.push(`  SSH details:  ${ctx.ssh_connection}`);
    if (ctx.tty) lines.push(`  TTY:          ${ctx.tty}`);
  }
  lines.push("");
  lines.push(`UA:        ${hit.userAgent ?? "-"}`);
  lines.push(
    `Browser:   ${hit.uaBrowser ?? "-"} ${hit.uaBrowserVersion ?? ""}`,
  );
  lines.push(`OS:        ${hit.uaOs ?? "-"}`);
  lines.push(`Device:    ${hit.uaDevice ?? "-"}`);
  if (hit.botLabel) lines.push(`Bot:       ${hit.botLabel}`);
  lines.push(`Referer:   ${hit.referer ?? "-"}`);
  return lines.filter((l) => l !== undefined).join("\n");
}

// re-export the log so workers can use the same logger
export { log };
