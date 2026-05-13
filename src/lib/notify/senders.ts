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
import { env, keyUrl } from "@/lib/env";
import { parseHostContext } from "@/lib/installers/headers";
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

export type SendContext = {
  key: Key;
  hit: Hit;
  target: string;
  /** Per-destination HMAC secret. Webhook body is signed with X-Mantis-Signature when set. */
  signingSecret?: string | null;
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
  });
}

// ---------------------------------------------------------------------------
// Slack — incoming webhook, blocks-based message
// ---------------------------------------------------------------------------

export async function sendSlack(ctx: SendContext): Promise<void> {
  const { key, hit } = ctx;
  const url = keyUrl(key.publicId);
  const hostCtx = parseHostContext(hit.headers as Record<string, string> | null);

  const fields: Array<{ type: "mrkdwn"; text: string }> = [
    { type: "mrkdwn", text: `*IP*\n${hit.ip ?? "—"}` },
    {
      type: "mrkdwn",
      text: `*UA*\n${truncate(hit.userAgent ?? "—", 80)}`,
    },
  ];
  if (hostCtx?.user) fields.push({ type: "mrkdwn", text: `*User*\n${hostCtx.user}` });
  if (hostCtx?.host) fields.push({ type: "mrkdwn", text: `*Host*\n${hostCtx.host}` });
  if (hostCtx?.ssh_client_ip) {
    fields.push({ type: "mrkdwn", text: `*SSH from*\n${hostCtx.ssh_client_ip}` });
  }
  if (hostCtx?.sudo_cmd) {
    fields.push({ type: "mrkdwn", text: `*Sudo cmd*\n\`${hostCtx.sudo_cmd}\`` });
  }

  await postJson(ctx.target, {
    text: `Mantis triggered: ${key.memo}`,
    blocks: [
      {
        type: "header",
        text: { type: "plain_text", text: `🪤 ${key.memo}`, emoji: true },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `<${url}|Mantis key URL> · ${hit.occurredAt.toISOString()}`,
        },
      },
      { type: "section", fields: fields.slice(0, 10) },
    ],
  });
}

// ---------------------------------------------------------------------------
// Discord — incoming webhook, embed message
// ---------------------------------------------------------------------------

export async function sendDiscord(ctx: SendContext): Promise<void> {
  const { key, hit } = ctx;
  const url = keyUrl(key.publicId);
  const hostCtx = parseHostContext(hit.headers as Record<string, string> | null);

  const fields: Array<{ name: string; value: string; inline?: boolean }> = [
    { name: "IP", value: hit.ip ?? "—", inline: true },
    {
      name: "UA",
      value: truncate(hit.userAgent ?? "—", 80),
      inline: false,
    },
  ];
  if (hostCtx?.user) fields.push({ name: "User", value: hostCtx.user, inline: true });
  if (hostCtx?.host) fields.push({ name: "Host", value: hostCtx.host, inline: true });
  if (hostCtx?.ssh_client_ip) {
    fields.push({ name: "SSH from", value: hostCtx.ssh_client_ip, inline: true });
  }
  if (hostCtx?.sudo_cmd) {
    fields.push({
      name: "Sudo cmd",
      value: "`" + truncate(hostCtx.sudo_cmd, 120) + "`",
      inline: false,
    });
  }

  await postJson(ctx.target, {
    username: "mantis",
    embeds: [
      {
        title: `Mantis triggered: ${key.memo}`,
        url,
        color: 0xef4444, // red-500
        timestamp: hit.occurredAt.toISOString(),
        fields: fields.slice(0, 25),
      },
    ],
  });
}

// ---------------------------------------------------------------------------
// Teams — Adaptive Card (Power Automate workflow webhook format)
// ---------------------------------------------------------------------------

export async function sendTeams(ctx: SendContext): Promise<void> {
  const { key, hit } = ctx;
  const url = keyUrl(key.publicId);
  const hostCtx = parseHostContext(hit.headers as Record<string, string> | null);

  const facts: Array<{ title: string; value: string }> = [
    { title: "IP", value: hit.ip ?? "—" },
    { title: "Occurred", value: hit.occurredAt.toISOString() },
    { title: "UA", value: truncate(hit.userAgent ?? "—", 120) },
  ];
  if (hostCtx?.user) facts.push({ title: "User", value: hostCtx.user });
  if (hostCtx?.host) facts.push({ title: "Host", value: hostCtx.host });
  if (hostCtx?.ssh_client_ip) {
    facts.push({ title: "SSH from", value: hostCtx.ssh_client_ip });
  }
  if (hostCtx?.sudo_cmd) {
    facts.push({ title: "Sudo cmd", value: hostCtx.sudo_cmd });
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
              text: `Mantis triggered: ${key.memo}`,
              wrap: true,
            },
            {
              type: "TextBlock",
              text: `[Open key in dashboard](${url})`,
              wrap: true,
              isSubtle: true,
              spacing: "Small",
            },
            { type: "FactSet", facts },
          ],
        },
      },
    ],
  });
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function postJson(
  url: string,
  body: unknown,
  opts: { signingSecret?: string | null } = {},
): Promise<void> {
  await safePostJson(url, body, {
    signingSecret: opts.signingSecret,
    userAgent: "mantis-webhook/0.13",
  });
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

function buildPayload({ key, hit }: SendContext) {
  return {
    type: "mantis.hit",
    key: {
      id: key.id,
      public_id: key.publicId,
      memo: key.memo,
      url: keyUrl(key.publicId),
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
  const url = keyUrl(key.publicId);
  const ctx = parseHostContext(hit.headers as Record<string, string> | null);
  const lines = [
    `Mantis triggered: ${key.memo}`,
    "",
    `Key URL: ${url}`,
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
