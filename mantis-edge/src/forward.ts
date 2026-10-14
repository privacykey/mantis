import {
  escapeCode,
  escapeMarkdown,
  escapeSlack,
  triggerLabel,
  truncateEscaped,
} from "./escape";
import { parseHostContext, type HostContext } from "./host-context";
import type { Channel, Payload } from "./types";

const SEND_TIMEOUT_MS = 5000;

// Delivery: one attempt plus up to two retries, only for failures that can
// clear by themselves (429, 5xx, network error, timeout). The Worker is
// stateless — nothing queues an alert once this invocation ends — so every
// attempt and every wait has to fit in the time Cloudflare lets
// ctx.waitUntil() keep running after the response is sent (30 s).
const MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 500;
const RETRY_JITTER_MS = 250;
// Longest wait we take on, including a Retry-After the destination asks for.
// A destination that wants more than this cannot be satisfied inside the
// budget, so the alert is reported as failed instead of retried too early.
const MAX_RETRY_WAIT_MS = 5000;
const FORWARD_BUDGET_MS = 25_000;
// Not worth starting an attempt with less time than this left.
const MIN_ATTEMPT_MS = 1000;

// Display budgets for values an anonymous caller controls (X-Mantis-* host
// context, IP, User-Agent), in characters AFTER escaping. Chat platforms
// reject the whole message when one element is over its limit, which would
// let a caller suppress its own alert with an oversized header. These sit far
// below the hard limits, so no combination of values can reach them:
//   Slack   — section field text 2000, at most 10 fields, header 150
//   Discord — field value 1024, field name / title 256, whole embed 6000
//   Teams   — whole message about 28 KB
const BUDGET = {
  ip: 64,
  userAgent: 120,
  user: 128,
  host: 255,
  device: 120,
  event: 120,
  sshClientIp: 64,
  sudoCmd: 160,
} as const;
// The memo is sealed into the URL by whoever minted it, not chosen by the
// caller, but an over-long one would trip the same limits.
const MEMO_BUDGET = { slackHeader: 140, discordTitle: 230, text: 300 } as const;

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
  // Built once: every attempt sends the same body (and the same hit id, so a
  // receiver can drop a duplicate if a timed-out attempt did get through).
  const body = JSON.stringify(
    formatBody({
      channel,
      triggerUrl: req.url,
      memo,
      occurredAt,
      ip,
      userAgent,
      referer,
      hostCtx,
      headers,
    }),
  );

  const deadline = Date.now() + FORWARD_BUDGET_MS;
  for (let attempt = 1; ; attempt++) {
    const result = await sendOnce(
      payload.w,
      body,
      Math.min(SEND_TIMEOUT_MS, deadline - Date.now()),
    );
    if (result.ok) return;

    const failure = attempt > 1 ? `${result.error} (attempt ${attempt})` : result.error;
    if (!result.retryable || attempt >= MAX_ATTEMPTS) throw new Error(failure);

    const wait =
      result.retryAfterMs !== undefined
        ? Math.max(result.retryAfterMs, RETRY_BASE_MS)
        : RETRY_BASE_MS * 2 ** (attempt - 1) +
          Math.floor(Math.random() * RETRY_JITTER_MS);
    if (wait > MAX_RETRY_WAIT_MS) {
      throw new Error(`${failure}; not retried: destination asked to wait ${Math.ceil(wait / 1000)}s`);
    }
    if (Date.now() + wait + MIN_ATTEMPT_MS > deadline) {
      throw new Error(`${failure}; not retried: out of time`);
    }
    await sleep(wait);
  }
}

type SendResult =
  | { ok: true }
  | { ok: false; error: string; retryable: boolean; retryAfterMs?: number };

async function sendOnce(
  url: string,
  body: string,
  timeoutMs: number,
): Promise<SendResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "mantis-edge-webhook/0.1",
      },
      body,
      redirect: "manual",
      signal: controller.signal,
    });
    // The response body is never read; release it before any retry.
    void res.body?.cancel().catch(() => {});
    if (res.status >= 300 && res.status < 400) {
      return { ok: false, error: `HTTP ${res.status} redirect refused`, retryable: false };
    }
    if (res.ok) return { ok: true };
    const error = `HTTP ${res.status} ${res.statusText}`.trimEnd();
    if (res.status === 429 || res.status >= 500) {
      return {
        ok: false,
        error,
        retryable: true,
        retryAfterMs: parseRetryAfter(res.headers.get("retry-after")),
      };
    }
    // Any other 4xx is a verdict on the request itself; repeating it cannot help.
    return { ok: false, error, retryable: false };
  } catch (err) {
    // Network failure, or our own timeout aborting the request.
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      retryable: true,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Retry-After as milliseconds from now: delay-seconds (Discord sends fractions) or an HTTP date. */
function parseRetryAfter(value: string | null): number | undefined {
  const v = value?.trim();
  if (!v) return undefined;
  if (/^\d+(\.\d+)?$/.test(v)) return Math.ceil(Number(v) * 1000);
  const at = Date.parse(v);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

// Escape, then cut to the display budget (never the other way round: the
// platform limits count escaped characters).
function slackValue(raw: string, budget: number): string {
  return truncateEscaped(escapeSlack(raw), budget, "slack");
}

function markdownValue(raw: string, budget: number): string {
  return truncateEscaped(escapeMarkdown(raw), budget, "markdown");
}

function formatSlack(ctx: FormatCtx): unknown {
  const field = (label: string, raw: string, budget: number) => ({
    type: "mrkdwn" as const,
    text: `*${label}*\n${slackValue(raw, budget)}`,
  });
  const fields: Array<{ type: "mrkdwn"; text: string }> = [
    field("IP", ctx.ip ?? "—", BUDGET.ip),
    field("UA", ctx.userAgent ?? "—", BUDGET.userAgent),
  ];
  if (ctx.hostCtx?.user) fields.push(field("User", ctx.hostCtx.user, BUDGET.user));
  if (ctx.hostCtx?.host) fields.push(field("Host", ctx.hostCtx.host, BUDGET.host));
  if (ctx.hostCtx?.device) fields.push(field("Device", ctx.hostCtx.device, BUDGET.device));
  if (ctx.hostCtx?.event) fields.push(field("Event", ctx.hostCtx.event, BUDGET.event));
  if (ctx.hostCtx?.ssh_client_ip) {
    fields.push(field("SSH from", ctx.hostCtx.ssh_client_ip, BUDGET.sshClientIp));
  }
  if (ctx.hostCtx?.sudo_cmd) {
    const cmd = truncateEscaped(
      escapeCode(escapeSlack(ctx.hostCtx.sudo_cmd)),
      BUDGET.sudoCmd,
      "slack",
    );
    fields.push({ type: "mrkdwn", text: `*Sudo cmd*\n\`${cmd}\`` });
  }

  const edge = triggerLabel(ctx.triggerUrl);
  const edgeId = escapeCode(escapeSlack(edge.id));
  const edgeHost = truncateEscaped(escapeCode(escapeSlack(edge.host)), BUDGET.host, "slack");

  return {
    text: `Mantis triggered: ${slackValue(ctx.memo, MEMO_BUDGET.text)}`,
    blocks: [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: `🪤 ${truncateEscaped(ctx.memo, MEMO_BUDGET.slackHeader, "plain")}`,
          emoji: true,
        },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          // Deliberately not a link, and `verbatim` stops Slack turning the
          // host name into one — see triggerLabel().
          text: `Edge canary \`${edgeId}\` on \`${edgeHost}\` · ${ctx.occurredAt}`,
          verbatim: true,
        },
      },
      { type: "section", fields: fields.slice(0, 10) },
    ],
  };
}

function formatDiscord(ctx: FormatCtx): unknown {
  const field = (name: string, raw: string, budget: number, inline: boolean) => ({
    name,
    value: markdownValue(raw, budget),
    inline,
  });
  const fields: Array<{ name: string; value: string; inline?: boolean }> = [
    field("IP", ctx.ip ?? "—", BUDGET.ip, true),
    field("UA", ctx.userAgent ?? "—", BUDGET.userAgent, false),
  ];
  if (ctx.hostCtx?.user) fields.push(field("User", ctx.hostCtx.user, BUDGET.user, true));
  if (ctx.hostCtx?.host) fields.push(field("Host", ctx.hostCtx.host, BUDGET.host, true));
  if (ctx.hostCtx?.device) fields.push(field("Device", ctx.hostCtx.device, BUDGET.device, true));
  if (ctx.hostCtx?.event) fields.push(field("Event", ctx.hostCtx.event, BUDGET.event, true));
  if (ctx.hostCtx?.ssh_client_ip) {
    fields.push(field("SSH from", ctx.hostCtx.ssh_client_ip, BUDGET.sshClientIp, true));
  }
  if (ctx.hostCtx?.sudo_cmd) {
    const cmd = truncateEscaped(escapeCode(ctx.hostCtx.sudo_cmd), BUDGET.sudoCmd, "plain");
    fields.push({ name: "Sudo cmd", value: "`" + cmd + "`", inline: false });
  }

  const edge = triggerLabel(ctx.triggerUrl);
  const edgeHost = truncateEscaped(escapeCode(edge.host), BUDGET.host, "plain");

  return {
    username: "mantis",
    embeds: [
      {
        // No `url`: it would make the title a link to the live trigger — see
        // triggerLabel().
        title: `Mantis triggered: ${truncateEscaped(ctx.memo, MEMO_BUDGET.discordTitle, "plain")}`,
        description: `Edge canary \`${escapeCode(edge.id)}\` on \`${edgeHost}\``,
        color: 0xef4444, // red-500
        timestamp: ctx.occurredAt,
        fields: fields.slice(0, 25),
      },
    ],
  };
}

function formatTeams(ctx: FormatCtx): unknown {
  const fact = (title: string, raw: string, budget: number) => ({
    title,
    value: markdownValue(raw, budget),
  });
  const facts: Array<{ title: string; value: string }> = [
    fact("IP", ctx.ip ?? "—", BUDGET.ip),
    { title: "Occurred", value: ctx.occurredAt },
    fact("UA", ctx.userAgent ?? "—", BUDGET.userAgent),
  ];
  if (ctx.hostCtx?.user) facts.push(fact("User", ctx.hostCtx.user, BUDGET.user));
  if (ctx.hostCtx?.host) facts.push(fact("Host", ctx.hostCtx.host, BUDGET.host));
  if (ctx.hostCtx?.device) facts.push(fact("Device", ctx.hostCtx.device, BUDGET.device));
  if (ctx.hostCtx?.event) facts.push(fact("Event", ctx.hostCtx.event, BUDGET.event));
  if (ctx.hostCtx?.ssh_client_ip) {
    facts.push(fact("SSH from", ctx.hostCtx.ssh_client_ip, BUDGET.sshClientIp));
  }
  if (ctx.hostCtx?.sudo_cmd) facts.push(fact("Sudo cmd", ctx.hostCtx.sudo_cmd, BUDGET.sudoCmd));

  const edge = triggerLabel(ctx.triggerUrl);

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
              text: `Mantis triggered: ${markdownValue(ctx.memo, MEMO_BUDGET.text)}`,
              wrap: true,
            },
            {
              type: "TextBlock",
              // Plain text, not a markdown link — see triggerLabel().
              text: `Edge canary ${escapeMarkdown(edge.id)} on ${markdownValue(edge.host, BUDGET.host)}`,
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
