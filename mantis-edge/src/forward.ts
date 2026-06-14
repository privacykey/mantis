import { escapeCode, escapeMarkdown, escapeSlack, safeDisplayUrl } from "./escape";
import { parseHostContext, type HostContext } from "./host-context";
import type { Channel, Payload } from "./types";

const SEND_TIMEOUT_MS = 5000;

// Cap on the cumulative bytes of header names+values we forward into the
// webhook body. Past this we drop the rest. Keeps a hostile client from
// inflating webhook payloads, and matches the server's behaviour.
const MAX_HEADER_SNAPSHOT_BYTES = 32 * 1024;

// Mirror of `SAFE_HEADER_NAMES` in src/lib/request-info.ts on the stateful
// server. KEEP IN SYNC. Anything not in this set (and not matching the
// `x-mantis-*` installer protocol prefix) is dropped before we POST to the
// webhook — most importantly cookies, `authorization`, `cf-access-*`
// session tokens, and any custom auth headers your reverse proxy injects.
const SAFE_HEADER_NAMES = new Set<string>([
  // browser context
  "accept",
  "accept-encoding",
  "accept-language",
  "accept-charset",
  "user-agent",
  "referer",
  "origin",
  // connection meta
  "host",
  "connection",
  "content-type",
  "content-length",
  "content-encoding",
  "range",
  // cache validation
  "cache-control",
  "pragma",
  "if-modified-since",
  "if-none-match",
  // browser security / fingerprint
  "dnt",
  "upgrade-insecure-requests",
  "sec-fetch-site",
  "sec-fetch-mode",
  "sec-fetch-user",
  "sec-fetch-dest",
  "sec-ch-ua",
  "sec-ch-ua-mobile",
  "sec-ch-ua-platform",
  "sec-ch-ua-platform-version",
  // forwarding / IP attribution
  "via",
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-real-ip",
  "cf-connecting-ip",
  "cf-ipcountry",
  "cf-ray",
  "cf-visitor",
  // distributed tracing (W3C)
  "traceparent",
  "tracestate",
]);

// Defence-in-depth: a credential-shaped header name still gets dropped
// even if it accidentally ends up in SAFE_HEADER_NAMES via a future edit.
const CREDENTIAL_PATTERNS = [
  /auth/,
  /token/,
  /secret/,
  /password/,
  /session/,
  /csrf/,
  /api[-_]?key/,
  /bearer/,
];

function isSafeHeaderName(name: string): boolean {
  // x-mantis-* is the installer protocol (X-Mantis-User, X-Mantis-Host,
  // X-Mantis-SSH-Connection, etc.) and must round-trip — parseHostContext
  // reads them on the receiving side.
  if (name.startsWith("x-mantis-")) return true;
  if (!SAFE_HEADER_NAMES.has(name)) return false;
  for (const re of CREDENTIAL_PATTERNS) {
    if (re.test(name)) return false;
  }
  return true;
}

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
    { type: "mrkdwn", text: `*IP*\n${escapeSlack(ctx.ip ?? "—")}` },
    {
      type: "mrkdwn",
      text: `*UA*\n${escapeSlack(truncate(ctx.userAgent ?? "—", 80))}`,
    },
  ];
  if (ctx.hostCtx?.user) {
    fields.push({ type: "mrkdwn", text: `*User*\n${escapeSlack(ctx.hostCtx.user)}` });
  }
  if (ctx.hostCtx?.host) {
    fields.push({ type: "mrkdwn", text: `*Host*\n${escapeSlack(ctx.hostCtx.host)}` });
  }
  if (ctx.hostCtx?.ssh_client_ip) {
    fields.push({
      type: "mrkdwn",
      text: `*SSH from*\n${escapeSlack(ctx.hostCtx.ssh_client_ip)}`,
    });
  }
  if (ctx.hostCtx?.sudo_cmd) {
    fields.push({
      type: "mrkdwn",
      text: `*Sudo cmd*\n\`${escapeCode(escapeSlack(truncate(ctx.hostCtx.sudo_cmd, 120)))}\``,
    });
  }

  return {
    text: `Mantis triggered: ${escapeSlack(ctx.memo)}`,
    blocks: [
      {
        type: "header",
        text: { type: "plain_text", text: `🪤 ${ctx.memo}`, emoji: true },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `<${safeDisplayUrl(ctx.triggerUrl)}|Edge URL> · ${ctx.occurredAt}`,
        },
      },
      { type: "section", fields: fields.slice(0, 10) },
    ],
  };
}

function formatDiscord(ctx: FormatCtx): unknown {
  const fields: Array<{ name: string; value: string; inline?: boolean }> = [
    { name: "IP", value: escapeMarkdown(ctx.ip ?? "—"), inline: true },
    {
      name: "UA",
      value: escapeMarkdown(truncate(ctx.userAgent ?? "—", 80)),
      inline: false,
    },
  ];
  if (ctx.hostCtx?.user) {
    fields.push({ name: "User", value: escapeMarkdown(ctx.hostCtx.user), inline: true });
  }
  if (ctx.hostCtx?.host) {
    fields.push({ name: "Host", value: escapeMarkdown(ctx.hostCtx.host), inline: true });
  }
  if (ctx.hostCtx?.ssh_client_ip) {
    fields.push({
      name: "SSH from",
      value: escapeMarkdown(ctx.hostCtx.ssh_client_ip),
      inline: true,
    });
  }
  if (ctx.hostCtx?.sudo_cmd) {
    fields.push({
      name: "Sudo cmd",
      value: "`" + escapeCode(truncate(ctx.hostCtx.sudo_cmd, 120)) + "`",
      inline: false,
    });
  }

  return {
    username: "mantis",
    embeds: [
      {
        title: `Mantis triggered: ${ctx.memo}`,
        url: safeDisplayUrl(ctx.triggerUrl),
        color: 0xef4444, // red-500
        timestamp: ctx.occurredAt,
        fields: fields.slice(0, 25),
      },
    ],
  };
}

function formatTeams(ctx: FormatCtx): unknown {
  const facts: Array<{ title: string; value: string }> = [
    { title: "IP", value: escapeMarkdown(ctx.ip ?? "—") },
    { title: "Occurred", value: ctx.occurredAt },
    { title: "UA", value: escapeMarkdown(truncate(ctx.userAgent ?? "—", 120)) },
  ];
  if (ctx.hostCtx?.user) facts.push({ title: "User", value: escapeMarkdown(ctx.hostCtx.user) });
  if (ctx.hostCtx?.host) facts.push({ title: "Host", value: escapeMarkdown(ctx.hostCtx.host) });
  if (ctx.hostCtx?.ssh_client_ip) {
    facts.push({ title: "SSH from", value: escapeMarkdown(ctx.hostCtx.ssh_client_ip) });
  }
  if (ctx.hostCtx?.sudo_cmd) {
    facts.push({ title: "Sudo cmd", value: escapeMarkdown(ctx.hostCtx.sudo_cmd) });
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
              text: `Mantis triggered: ${escapeMarkdown(ctx.memo)}`,
              wrap: true,
            },
            {
              type: "TextBlock",
              text: `[Edge URL](${safeDisplayUrl(ctx.triggerUrl)})`,
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
  let used = 0;
  h.forEach((v, k) => {
    const name = k.toLowerCase();
    if (!isSafeHeaderName(name)) return;
    const cost = name.length + (v?.length ?? 0);
    if (used + cost > MAX_HEADER_SNAPSHOT_BYTES) return;
    out[name] = v;
    used += cost;
  });
  return out;
}
