import { request as httpRequest } from "node:http";

// Raw-HTTP client for the Tier-2 suite. Uses node:http directly instead of
// fetch: the Host header is on fetch's forbidden list (undici silently drops
// it), and the whole point of the host-split tests is to control it.

const DEFAULT_BASE = "http://127.0.0.1:3100";

export function tier2BaseUrl(): URL {
  return new URL(process.env.MANTIS_TIER2_BASE_URL ?? DEFAULT_BASE);
}

function firstHost(value: string | undefined, fallback: string): string {
  const host = (value ?? "").trim().split(/[\s,]+/)[0];
  return host || fallback;
}

// Must match the host lists the server under test was started with
// (scripts/test-tier2.sh exports the same values to both processes).
export const PUBLIC_HOST = firstHost(
  process.env.PUBLIC_ONLY_HOSTS,
  "public.mantis.test",
);
export const DASHBOARD_HOST = firstHost(
  process.env.DASHBOARD_HOSTS,
  "dash.mantis.test",
);

export type RawResponse = {
  status: number;
  headers: NodeJS.Dict<string | string[]>;
  setCookies: string[];
  body: string;
};

/**
 * One HTTP request against the running standalone server. `host` overrides the
 * Host HEADER only — the TCP connection always goes to MANTIS_TIER2_BASE_URL,
 * mirroring how a reverse proxy delivers foreign-host traffic to the app.
 */
export function rawRequest(
  path: string,
  init: {
    method?: string;
    host?: string;
    headers?: Record<string, string>;
    body?: Buffer | string;
  } = {},
): Promise<RawResponse> {
  const base = tier2BaseUrl();
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        protocol: base.protocol,
        hostname: base.hostname,
        port: base.port,
        path,
        method: init.method ?? "GET",
        headers: {
          ...(init.host ? { host: init.host } : {}),
          ...init.headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            setCookies: res.headers["set-cookie"] ?? [],
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    req.on("error", reject);
    if (init.body !== undefined) req.write(init.body);
    req.end();
  });
}

/** Encodes fields the way a browser submits a server-action form (multipart). */
export function multipartForm(fields: Array<[string, string]>): {
  contentType: string;
  body: Buffer;
} {
  const boundary = `----mantisTier2${Math.random().toString(36).slice(2)}`;
  const parts: string[] = [];
  for (const [name, value] of fields) {
    parts.push(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="${name}"\r\n\r\n` +
        `${value}\r\n`,
    );
  }
  parts.push(`--${boundary}--\r\n`);
  return {
    contentType: `multipart/form-data; boundary=${boundary}`,
    body: Buffer.from(parts.join(""), "utf8"),
  };
}

const HTML_ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#x27;": "'",
  "&#39;": "'",
};

function unescapeHtml(value: string): string {
  return value.replace(
    /&(?:amp|lt|gt|quot|#x27|#39);/g,
    (m) => HTML_ENTITIES[m] ?? m,
  );
}

/**
 * Pulls React's hidden `$ACTION…` inputs out of a server-rendered form. Echoing
 * them back in the POST is what routes a no-JS (progressive-enhancement) form
 * submission to the right server action — the names are build-dependent, so
 * they must be scraped from the served HTML rather than hard-coded.
 */
export function extractActionFields(html: string): Array<[string, string]> {
  const fields: Array<[string, string]> = [];
  for (const tag of html.match(/<input\b[^>]*>/g) ?? []) {
    const attr = (name: string): string | null => {
      const m = tag.match(new RegExp(`\\b${name}="([^"]*)"`));
      return m?.[1] !== undefined ? unescapeHtml(m[1]) : null;
    };
    if (attr("type") !== "hidden") continue;
    const name = attr("name");
    if (!name || !name.startsWith("$ACTION")) continue;
    fields.push([name, attr("value") ?? ""]);
  }
  return fields;
}
