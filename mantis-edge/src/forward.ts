import { parseHostContext, type HostContext } from "./host-context";
import type { Channel, Payload } from "./types";

const SEND_TIMEOUT_MS = 5000;

export async function forward(payload: Payload, req: Request): Promise<void> {
  const headers = snapshotHeaders(req.headers);
  const occurredAt = new Date().toISOString();
  const hostCtx = parseHostContext(headers);
  const memo = payload.m ?? "(no memo)";
  const ip = req.headers.get("cf-connecting-ip");
  const userAgent = req.headers.get("user-agent");
  const referer = req.headers.get("referer");

  const channel: Channel = payload.c ?? "webhook";
  const body = formatBody({
    channel,
    triggerUrl: req.url,
    memo,
    occurredAt,
    ip,
    userAgent,
    referer,
    hostCtx,
    headers,
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
  try {
    const res = await fetch(payload.w, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "mantis-edge-webhook/0.1",
      },
      body: JSON.stringify(body),
      redirect: "manual",
      signal: controller.signal,
    });
    if (res.status >= 300 && res.status < 400) {
      throw new Error(`HTTP ${res.status} redirect refused`);
    }
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

type FormatCtx = {
  channel: Channel;
  triggerUrl: string;
  memo: string;
  occurredAt: string;
  ip: string | null;
  userAgent: string | null;
  referer: string | null;
  hostCtx: HostContext | null;
  headers: Record<string, string>;
};

function formatBody(ctx: FormatCtx): unknown {
  switch (ctx.channel) {
    case "slack":
      return formatSlack(ctx);
    case "discord":
      return formatDiscord(ctx);
    case "teams":
      return formatTeams(ctx);
    case "webhook":
    default:
      return formatRaw(ctx);
  }
}

function formatRaw(ctx: FormatCtx): unknown {
  return {
    type: "mantis.hit",
    key: {
      id: null,
      public_id: null,
      memo: ctx.memo === "(no memo)" ? null : ctx.memo,
      url: ctx.triggerUrl,
    },
    hit: {
      id: crypto.randomUUID(),
      occurred_at: ctx.occurredAt,
      ip: ctx.ip,
      user_agent: ctx.userAgent,
      referer: ctx.referer,
      ua_browser: null,
      ua_browser_version: null,
      ua_os: null,
      ua_device: null,
      bot_label: null,
      is_duplicate: false,
      host_context: ctx.hostCtx,
      headers: ctx.headers,
    },
  };
}

function formatSlack(ctx: FormatCtx): unknown {
  const fields: Array<{ type: "mrkdwn"; text: string }> = [
    { type: "mrkdwn", text: `*IP*\n${ctx.ip ?? "—"}` },
    {
      type: "mrkdwn",
      text: `*UA*\n${truncate(ctx.userAgent ?? "—", 80)}`,
    },
  ];
  if (ctx.hostCtx?.user) {
    fields.push({ type: "mrkdwn", text: `*User*\n${ctx.hostCtx.user}` });
  }
  if (ctx.hostCtx?.host) {
    fields.push({ type: "mrkdwn", text: `*Host*\n${ctx.hostCtx.host}` });
  }
  if (ctx.hostCtx?.ssh_client_ip) {
    fields.push({
      type: "mrkdwn",
      text: `*SSH from*\n${ctx.hostCtx.ssh_client_ip}`,
    });
  }
  if (ctx.hostCtx?.sudo_cmd) {
    fields.push({
      type: "mrkdwn",
      text: `*Sudo cmd*\n\`${truncate(ctx.hostCtx.sudo_cmd, 120)}\``,
    });
  }

  return {
    text: `Mantis triggered: ${ctx.memo}`,
    blocks: [
      {
        type: "header",
        text: { type: "plain_text", text: `🪤 ${ctx.memo}`, emoji: true },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `<${ctx.triggerUrl}|Edge URL> · ${ctx.occurredAt}`,
        },
      },
      { type: "section", fields: fields.slice(0, 10) },
    ],
  };
}

function formatDiscord(ctx: FormatCtx): unknown {
  const fields: Array<{ name: string; value: string; inline?: boolean }> = [
    { name: "IP", value: ctx.ip ?? "—", inline: true },
    {
      name: "UA",
      value: truncate(ctx.userAgent ?? "—", 80),
      inline: false,
    },
  ];
  if (ctx.hostCtx?.user) {
    fields.push({ name: "User", value: ctx.hostCtx.user, inline: true });
  }
  if (ctx.hostCtx?.host) {
    fields.push({ name: "Host", value: ctx.hostCtx.host, inline: true });
  }
  if (ctx.hostCtx?.ssh_client_ip) {
    fields.push({
      name: "SSH from",
      value: ctx.hostCtx.ssh_client_ip,
      inline: true,
    });
  }
  if (ctx.hostCtx?.sudo_cmd) {
    fields.push({
      name: "Sudo cmd",
      value: "`" + truncate(ctx.hostCtx.sudo_cmd, 120) + "`",
      inline: false,
    });
  }

  return {
    username: "mantis",
    embeds: [
      {
        title: `Mantis triggered: ${ctx.memo}`,
        url: ctx.triggerUrl,
        color: 0xef4444, // red-500
        timestamp: ctx.occurredAt,
        fields: fields.slice(0, 25),
      },
    ],
  };
}

function formatTeams(ctx: FormatCtx): unknown {
  const facts: Array<{ title: string; value: string }> = [
    { title: "IP", value: ctx.ip ?? "—" },
    { title: "Occurred", value: ctx.occurredAt },
    { title: "UA", value: truncate(ctx.userAgent ?? "—", 120) },
  ];
  if (ctx.hostCtx?.user) facts.push({ title: "User", value: ctx.hostCtx.user });
  if (ctx.hostCtx?.host) facts.push({ title: "Host", value: ctx.hostCtx.host });
  if (ctx.hostCtx?.ssh_client_ip) {
    facts.push({ title: "SSH from", value: ctx.hostCtx.ssh_client_ip });
  }
  if (ctx.hostCtx?.sudo_cmd) {
    facts.push({ title: "Sudo cmd", value: ctx.hostCtx.sudo_cmd });
  }

  return {
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
              text: `Mantis triggered: ${ctx.memo}`,
              wrap: true,
            },
            {
              type: "TextBlock",
              text: `[Edge URL](${ctx.triggerUrl})`,
              wrap: true,
              isSubtle: true,
              spacing: "Small",
            },
            { type: "FactSet", facts },
          ],
        },
      },
    ],
  };
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

function snapshotHeaders(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((v, k) => {
    out[k] = v;
  });
  return out;
}
