import { forward } from "./forward";
import { isPrivateLiteralHost } from "./private-host";
import { buildResponse } from "./response";
import { b64urlDecode, unseal } from "./seal";
import { CHANNELS, RESPONSE_KINDS, type Env, type Payload } from "./types";

const PATH_RE = /^\/c\/([A-Za-z0-9_-]+)$/;

export default {
  async fetch(
    req: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(req.url);
    const match = PATH_RE.exec(url.pathname);
    if (!match) return notFound();

    let keyRaw: Uint8Array;
    try {
      keyRaw = b64urlDecode(env.MANTIS_EDGE_KEY);
    } catch {
      return notFound();
    }
    if (keyRaw.length !== 32) return notFound();

    let payload: Payload;
    try {
      const sealed = b64urlDecode(match[1]!);
      const plaintext = await unseal(sealed, keyRaw);
      const parsed = JSON.parse(new TextDecoder().decode(plaintext)) as unknown;
      if (!isPayload(parsed)) return notFound();
      payload = parsed;
    } catch {
      return notFound();
    }

    if (
      typeof payload.exp === "number" &&
      Date.now() / 1000 > payload.exp
    ) {
      return notFound();
    }

    if (!isWebhookAllowed(payload.w, env.MANTIS_EDGE_WEBHOOK_ALLOWLIST)) {
      console.warn("mantis-edge blocked webhook (private address or outside allowlist)", {
        target: summarizeUrl(payload.w),
      });
      return notFound();
    }

    ctx.waitUntil(
      forward(payload, req).catch((err) => {
        console.warn("mantis-edge webhook forward failed", {
          target: summarizeUrl(payload.w),
          error: err instanceof Error ? err.message : String(err),
        });
      }),
    );

    return buildResponse(payload);
  },
} satisfies ExportedHandler<Env>;

function isPayload(v: unknown): v is Payload {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  if (typeof o.w !== "string" || !isHttpUrl(o.w)) return false;
  if (o.c !== undefined && !CHANNELS.includes(o.c as never)) return false;
  if (o.r !== undefined && !RESPONSE_KINDS.includes(o.r as never)) return false;
  if (o.m !== undefined && typeof o.m !== "string") return false;
  if (o.exp !== undefined && typeof o.exp !== "number") return false;
  return true;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function isWebhookAllowed(webhook: string, allowlist: string | undefined): boolean {
  let hostname: string;
  try {
    hostname = normalizeHostname(new URL(webhook).hostname);
  } catch {
    return false;
  }

  const rules = parseAllowlist(allowlist);
  if (rules.length === 0) {
    // No allowlist configured: default-open for public hosts, but never
    // forward to a literal private / loopback / metadata IP. The edge can't
    // resolve hostnames, so set MANTIS_EDGE_WEBHOOK_ALLOWLIST to lock down
    // hostname targets too.
    return !isPrivateLiteralHost(hostname);
  }

  return rules.some((rule) =>
    rule.kind === "exact"
      ? hostname === rule.hostname
      : hostname.endsWith(`.${rule.hostname}`),
  );
}

type AllowRule =
  | { kind: "exact"; hostname: string }
  | { kind: "wildcard"; hostname: string };

function parseAllowlist(raw: string | undefined): AllowRule[] {
  return (raw ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map(parseAllowRule)
    .filter((rule): rule is AllowRule => rule !== null);
}

function parseAllowRule(entry: string): AllowRule | null {
  let raw = entry.toLowerCase();
  try {
    if (raw.includes("://")) raw = new URL(raw).hostname;
  } catch {
    return null;
  }

  const wildcard =
    raw.startsWith("*.") || raw.startsWith(".");
  const hostname = normalizeHostname(
    raw.replace(/^\*\./, "").replace(/^\./, ""),
  );
  if (!hostname) return null;

  return wildcard
    ? { kind: "wildcard", hostname }
    : { kind: "exact", hostname };
}

function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/\.$/, "");
}

function summarizeUrl(value: string): string {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}`;
  } catch {
    return "invalid-url";
  }
}

function notFound(): Response {
  return new Response(JSON.stringify({ error: "not_found" }), {
    status: 404,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
}
