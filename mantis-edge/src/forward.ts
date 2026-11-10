import {
  escapeCode,
  escapeMarkdown,
  escapeSlack,
  escapeTeams,
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
// context, IP, User-Agent), in characters before channel formatting. Chat platforms
// reject the whole message when one element is over its limit, which would
// let a caller suppress its own alert with an oversized header. These sit far
// below the hard limits, so no combination of values can reach them:
//   Slack   — message text 4000 (recommended), header 150
//   Discord — description 4096, title 256, whole embed 6000
//   Teams   — whole message about 28 KB
const BUDGET = {
  ip: 64,
  userAgent: 38,
  user: 128,
  host: 255,
  device: 120,
  event: 120,
  source: 64,
  sshClientIp: 64,
  sudoCmd: 52,
} as const;
// The memo is sealed into the URL by whoever minted it, not chosen by the
// caller, but an over-long one would trip the same limits.
const MEMO_BUDGET = 60;
const ACTOR_BUDGET = 36;
const CHAT_PRODUCT = "Mantis Edge";
const CHAT_STATUS = "tripped";
const NO_ACTOR_DETAILS = "No actor or SSH client reported.";
const NO_REQUEST_IP = "No request IP observed.";

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
  const memo = payload.m ?? null;
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
  memo: string | null;
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

const TRIP_COLOUR = 0xef4444;
// A 4×1 PNG of TRIP_COLOUR, repeated down the left edge of the Teams card.
// Keeping it inline avoids a network request when the alert is opened.
const TEAMS_TRIP_RAIL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAQAAAABCAIAAAB2XpiaAAAADUlEQVR4nGN47+ICRwAozwXdPKVQgAAAAABJRU5ErkJggg==";

type ChatText = { text: string; style?: "bold" | "code" | "identity" | "address" | "subtle" | "annotation"; timestamp?: number };
type ChatLine = ChatText[];
type ChatFact = { label: string; value: string; style?: "address" | "command"; note?: string };

function oneLine(value: string | null | undefined): string {
  return value?.trim().replace(/[\r\n\u2028\u2029]+/g, " ") ?? "";
}

function displayText(value: string | null | undefined, budget: number): string {
  return truncateEscaped(oneLine(value), budget, "plain");
}

// Keep both ends of a long memo or command, within the platform's UTF-16 limit.
function middleParts(value: string, limit: number): [string, string] {
  let head = truncateEscaped(value, Math.ceil(limit * 0.6) - 2, "plain").slice(0, -1);
  let tailStart = value.length - (limit - head.length - 3);
  const boundary = Math.max(...[" ", "-", ".", "/", "_"].map((separator) => value.lastIndexOf(separator, tailStart - 1))) + 1;
  if (boundary > 0 && value.length - boundary <= Math.floor(limit / 2)) {
    tailStart = boundary;
    head = truncateEscaped(value, limit - 2 - (value.length - tailStart), "plain").slice(0, -1);
  }
  const headBoundary = Math.max(...[" ", "-", ".", "/", "_"].map((separator) => head.lastIndexOf(separator)));
  if (headBoundary > head.length / 2) head = head.slice(0, headBoundary);
  const first = value.charCodeAt(tailStart);
  const startsInsideCharacter = first >= 0xdc00 && first <= 0xdfff;
  return [head, value.slice(startsInsideCharacter ? tailStart + 1 : tailStart)];
}

function fitMiddle(value: string, limit: number): string {
  return value.length <= limit ? value : middleParts(value, limit).join("…\u2060");
}

function fitMemo(value: string): string {
  if (value.length <= MEMO_BUDGET) return value;
  let [head, tail] = middleParts(value, MEMO_BUDGET);
  const tailBreak = tail.includes(" ") ? tail.indexOf(" ") : tail.indexOf("-");
  if (tailBreak >= 0 && tailBreak < tail.length - 1) tail = tail.slice(tailBreak + 1);
  return `${head.trimEnd()}…\u2060${tail.trimStart()}`.replace(/-(?=\S)/g, "-\u2060");
}

// Plain address typography is safe only for address-shaped values. Other
// caller-supplied text keeps a literal code treatment, preventing auto-links.
function addressStyle(value: string): "address" | "code" {
  const ipv4 = /^(?:\d{1,3}\.){3}\d{1,3}$/.test(value) &&
    value.split(".").every((part) => Number(part) <= 255);
  const ipv6 = value.includes(":") && /^[a-f\d:]+$/i.test(value);
  return ipv4 || ipv6 ? "address" : "code";
}

function fitActor(account: string, machine: string, limit: number): string {
  const identity = `${account}@${machine}`;
  if (identity.length <= limit) return identity;
  const user = fitMiddle(account, Math.floor(limit / 3));
  const hostBudget = limit - user.length - 1;
  if (machine.length <= hostBudget) return `${user}@${machine}`;
  const labels = machine.split(".");
  const suffix = labels.slice(-2).join(".");
  const prefixBudget = hostBudget - suffix.length - 2;
  if (addressStyle(machine) === "address" || labels.length < 3 || prefixBudget < 6) {
    return `${user}@${fitMiddle(machine, hostBudget)}`;
  }
  // Keep identifying machine text as well as the domain used to locate it.
  const firstLabel = labels[0]!;
  const prefix = firstLabel.length <= prefixBudget ? firstLabel
    : firstLabel.length <= 2 * prefixBudget ? fitMiddle(firstLabel, prefixBudget)
    : truncateEscaped(firstLabel, prefixBudget + 1, "plain").slice(0, -1);
  return `${user}@${prefix}…\u2060${suffix}`;
}

function chatAlert(ctx: FormatCtx) {
  const host = ctx.hostCtx;
  const edge = triggerLabel(ctx.triggerUrl);
  const memo = oneLine(ctx.memo);
  const title = memo && memo !== "(no memo)" ? fitMemo(memo) : "Unnamed canary";
  const time = ctx.occurredAt.slice(0, 19).replace("T", " ");
  const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(time.slice(5, 7)) - 1];
  const shortTime = `${Number(time.slice(8, 10))} ${month} ${time.slice(11)}`;
  const status: ChatLine = [
    { text: "🔴 " },
    { text: CHAT_STATUS, style: "bold" },
  ];
  if (ctx.channel !== "teams") status.push(
    { text: " · " },
    { text: `${time} UTC`, timestamp: Math.floor(Date.parse(ctx.occurredAt) / 1000) },
  );
  const exactTime = `${shortTime} UTC`.replace(/ /g, "\u00a0");
  status.push({ text: ctx.channel === "teams" ? `\u00a0· ${exactTime}` : ` (${exactTime})` });

  const account = displayText(host?.user, BUDGET.user);
  const machine = displayText(host?.host, BUDGET.host);
  const device = displayText(host?.device, BUDGET.device);
  const event = displayText(host?.event, BUDGET.event);
  const source = displayText(host?.source, BUDGET.source);
  const hasReportedSsh = Boolean(oneLine(host?.ssh_client_ip));
  const sharedAddress = hasReportedSsh && host?.ssh_client_ip === ctx.ip;
  const reportedSsh = sharedAddress ? "" : displayText(host?.ssh_client_ip, BUDGET.sshClientIp);
  const requestIp = displayText(ctx.ip, BUDGET.ip);
  const identity = account && machine ? `${account}@${machine}` : "";
  const inlineReportedSsh = Boolean(identity && reportedSsh && identity.length < 21 && reportedSsh.length < 24 && identity.length + reportedSsh.length < 43 && /^[\x20-\x7e]+$/.test(identity + reportedSsh));
  const lead: ChatLine[] = [];
  if (identity) {
    const actor: ChatLine = [{ text: fitActor(account, machine, ACTOR_BUDGET), style: "identity" }];
    if (inlineReportedSsh) {
      actor.push({ text: " ←\u00a0reported\u00a0IP:\u00a0", style: "annotation" }, { text: reportedSsh, style: addressStyle(reportedSsh) });
    }
    lead.push(actor);
  } else if (account || machine) {
    lead.push([
      { text: account ? "User: " : "Host: ", style: "subtle" },
      { text: account || machine, style: "bold" },
    ]);
  }
  if (device && (device !== memo || !event)) {
    lead.push([{ text: "Device: ", style: "subtle" }, { text: device, style: "bold" }]);
  }
  if (event) {
    lead.push(event === "unexpected-online"
      ? [{ text: "Came online unexpectedly", style: "bold" }]
      : [{ text: "Event: ", style: "subtle" }, { text: event, style: "bold" }],
    );
  }
  const hasActor = lead.length > 0;
  if (reportedSsh) {
    if (!inlineReportedSsh) {
      lead.push([{ text: `${identity ? "←\u00a0" : ""}reported IP: `, style: "annotation" }, { text: reportedSsh, style: addressStyle(reportedSsh) }]);
    }
  }
  const command = oneLine(host?.sudo_cmd);
  if (command) lead.push([{ text: `sudo ${fitMiddle(command, BUDGET.sudoCmd)}`, style: "code" }]);
  if (source) lead.push([{ text: "Source: ", style: "subtle" }, { text: source }]);
  const facts: ChatFact[] = requestIp
    ? [{ label: "Observed IP", value: requestIp, style: "address", ...(sharedAddress ? { note: "also reported SSH client" } : {}) }]
    : [];
  const agentSource = oneLine(ctx.userAgent);
  const agent = /https?:\/\//i.test(agentSource)
    ? displayText(agentSource, BUDGET.userAgent)
    : fitMiddle(agentSource, BUDGET.userAgent);
  const metadata: Array<{ text: string }> = [];
  if (!hasActor && !hasReportedSsh && !requestIp) {
    if (lead.length) metadata.push({ text: "No actor, SSH client or request IP available." });
    else metadata.push({ text: "No source details reported." });
  }
  else {
    if (!hasActor && !hasReportedSsh) metadata.push({ text: NO_ACTOR_DETAILS });
    if (!requestIp) metadata.push({ text: NO_REQUEST_IP });
  }
  if (agent) metadata.push({ text: `agent: “${agent}”` });
  const worker = `${CHAT_PRODUCT}, ${displayText(edge.host, BUDGET.host)}`;
  // Keep the short reference intact when the provenance line wraps.
  const reference = edge.id.replace(/[…-]/g, (part) => `\u2060${part}\u2060`);
  metadata.push({ text: edge.id === "unknown" ? worker : `${worker}, ref\u00a0${reference}` });
  return { title, status, lead, facts, metadata };
}

function plainLine(line: ChatLine): string {
  return line.map(({ text }) => text).join("");
}

function factValue({ value, style }: ChatFact): ChatText {
  return { text: value, style: style === "address" ? addressStyle(value) : style === "command" ? "code" : undefined };
}

function factLine(fact: ChatFact): ChatLine {
  return [
    ...(fact.label ? [{ text: `${fact.label.replace(/^./, (c) => c.toLowerCase())}:${fact.value.length >= 28 ? "\n" : " "}`, style: "annotation" as const }] : []),
    factValue(fact),
    ...(fact.note ? [{ text: ` (${fact.note})`, style: "annotation" as const }] : []),
  ];
}

function formatSlack(ctx: FormatCtx): unknown {
  const { title, status, lead, facts, metadata } = chatAlert(ctx);
  const footer = metadata.map(({ text }) => text).join("\n");
  const plain = (text: string) => ({ type: "plain_text", text });
  const styles = {
    bold: { bold: true },
    code: { code: true },
    identity: { bold: true },
    address: undefined,
    subtle: undefined,
    annotation: { italic: true },
  };
  const rich = (lines: ChatLine[]) => ({
    type: "rich_text",
    elements: [{
      type: "rich_text_section",
      elements: lines.flatMap((line, i) => [
        ...(i ? [{ type: "text", text: "\n" }] : []),
        ...line.map(({ text, style, timestamp }) => timestamp !== undefined ? ({
          type: "date", timestamp, format: "{ago}", fallback: text,
        }) : ({
          type: "text",
          text,
          ...(style && styles[style] ? { style: styles[style] } : {}),
        })),
      ]),
    }],
  });
  const fallback = truncateEscaped(escapeSlack([
    CHAT_PRODUCT,
    title,
    `🔴 ${CHAT_STATUS} · ${ctx.occurredAt.slice(0, 19).replace("T", " ")} UTC`,
    ...lead.map(plainLine),
    ...facts.map((fact) => plainLine(factLine(fact))),
    footer,
  ].join("\n")), 4000, "slack");
  return {
    mrkdwn: false,
    unfurl_links: false,
    unfurl_media: false,
    attachments: [{
      color: `#${TRIP_COLOUR.toString(16)}`,
      fallback,
      blocks: [
        { type: "header", text: plain(title) },
        rich([status]),
        ...(lead.length ? [rich(lead)] : []),
        ...(facts.length ? [rich(facts.map(factLine))] : []),
        { type: "context", elements: [plain(footer)] },
      ],
    }],
  };
}

function formatDiscord(ctx: FormatCtx): unknown {
  const { title, status, lead, facts, metadata } = chatAlert(ctx);
  const markdown = (line: ChatLine) => {
    const rendered = line.map(({ text, style, timestamp }) => {
      if (timestamp !== undefined) return `<t:${timestamp}:R>`;
      if (style === "identity") return `**${escapeMarkdown(text)}**`;
      if (style === "code") return `\`${escapeCode(text)}\``;
      const escaped = escapeMarkdown(text);
      return style === "bold" ? `**${escaped}**` : style === "annotation" ? escaped.replace(/^(\s*)(.*?)(\s*)$/s, "$1*$2*$3") : escaped;
    }).join("");
    return rendered;
  };
  const groups = [markdown(status), lead.map(markdown).join("\n")].filter(Boolean);
  if (facts.length) groups.push(facts.map((fact) => markdown(factLine(fact))).join("\n"));

  return {
    username: "mantis",
    allowed_mentions: { parse: [] },
    embeds: [{
      title,
      description: groups.join("\n\n"),
      color: TRIP_COLOUR,
      footer: { text: metadata.map(({ text }) => text).join("\n") },
    }],
  };
}

function formatTeams(ctx: FormatCtx): unknown {
  const { title, status, lead, facts, metadata } = chatAlert(ctx);
  const mono = (style: ChatText["style"]) => style === "code";
  const bold = (style: ChatText["style"]) => style === "bold" || style === "identity";
  const row = (line: ChatLine, spacing: string, size?: "Small") => {
    const command = line.length === 1 && line[0]?.style === "code" && line[0].text.startsWith("sudo ");
    // Keep shortened service names together when they fit the native body font.
    const text = plainLine(line);
    if (command) return {
      type: "TextBlock",
      text: `$ ${escapeTeams(text.includes("…\u2060") ? text.replace(/-(?=\S)/g, "-\u2060") : text)}`,
      fontType: "Default",
      weight: "Default",
      wrap: true,
      spacing,
    };
    // TextBlock gives commands a compact, consistent line height and wraps
    // unbroken hostnames or IPv6 addresses without changing their contents.
    const wideCharacters = line.some(({ text }) => /[^\x00-\x7f\u2026\u2060\u00a0]/.test(text));
    const unbroken = wideCharacters ? /\S{21}/ : size === "Small" ? /\S{32}/ : /\S{24}/;
    if (line.some(({ text }) => unbroken.test(text))) {
      return {
        type: "TextBlock",
        text: escapeTeams(plainLine(line)),
        wrap: true,
        spacing,
        color: "Default",
        isSubtle: false,
        ...(line.some(({ style }) => bold(style)) ? { weight: "Bolder" } : {}),
        ...(line.some(({ style }) => mono(style)) ? { fontType: "Monospace" } : {}),
        ...(line.every(({ style }) => style === "subtle") ? { isSubtle: true } : {}),
        ...(size ? { size, isSubtle: true } : {}),
      };
    }
    return {
      type: "RichTextBlock",
      spacing,
      inlines: line.map(({ text, style }) => ({
        type: "TextRun",
        text,
        weight: bold(style) ? "Bolder" : "Default",
        color: "Default",
        isSubtle: false,
        ...(mono(style) ? { fontType: "Monospace" } : {}),
        ...(style === "subtle" || style === "annotation" ? { isSubtle: true, size: "Small" } : {}),
        ...(size ? { size, isSubtle: true } : {}),
      })),
    };
  };
  const group = (lines: ChatLine[]) => lines.map((line, i) => row(line, i ? "None" : "Small"));
  const factSpacing = "Small";
  const fact = ({ label, value, style, note }: ChatFact, i: number) => value.length < 28 ? [row(
    factLine({ label, value, style, note }), i ? "None" : factSpacing,
  )] : [
    { type: "TextBlock", text: `${label.replace(/^./, (c) => c.toLowerCase())}:`, wrap: true, size: "Small", isSubtle: true, spacing: i ? "Small" : factSpacing },
    {
      type: "TextBlock",
      text: escapeTeams(value),
      ...(factValue({ label, value, style }).style === "code" ? { fontType: "Monospace" } : {}),
      spacing: "None",
      wrap: true,
    },
    ...(note ? [row([{ text: `(${note})`, style: "annotation" }], "None", "Small")] : []),
  ];

  return {
    type: "message",
    attachments: [
      {
        contentType: "application/vnd.microsoft.card.adaptive",
        content: {
          $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
          type: "AdaptiveCard",
          version: "1.4",
          backgroundImage: { url: TEAMS_TRIP_RAIL, fillMode: "repeatVertically" },
          body: [
            { type: "TextBlock", text: escapeTeams(title), wrap: true, size: "Large", weight: "Bolder", spacing: "None" },
            row(status, "Small"),
            ...group(lead),
            ...facts.flatMap(fact),
            ...metadata.map(({ text }, i) => {
              const spacing = !i ? "Small" : "None";
              return { type: "TextBlock", text: escapeTeams(text), wrap: true, size: "Small", isSubtle: true, spacing };
            }),
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
