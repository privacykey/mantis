import type { Payload } from "./types";

// 43-byte 1×1 transparent GIF89a
const GIF_B64 = "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

// Mirror of the stateful server's HTML response CSP (src/lib/response.ts).
// Operator-controlled HTML is sandboxed to: no JS, no plugins, no
// top-level navigation, no <base> hijack, no form submission. Inline
// styles and HTTPS image fetches are allowed because most paste-in HTML
// includes them. KEEP IN SYNC with the server.
const HTML_CSP =
  "default-src 'none'; img-src https: data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; sandbox";

function gifBytes(): Uint8Array<ArrayBuffer> {
  const bin = atob(GIF_B64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export function buildResponse(payload: Payload): Response {
  const kind = payload.r ?? "gif";
  switch (kind) {
    case "empty":
      return new Response(null, {
        status: 204,
        headers: { "cache-control": "no-store" },
      });

    case "json":
      return new Response(JSON.stringify(payload.p ?? { ok: true }), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "cache-control": "no-store",
        },
      });

    case "redirect": {
      const target =
        typeof payload.p === "object" && payload.p !== null
          ? (payload.p as { url?: unknown }).url
          : undefined;
      if (typeof target !== "string" || !/^https?:\/\//.test(target)) {
        // Mis-formed payload — fall back to gif so we don't expose the misconfig
        return gifResponse();
      }
      // Hand-built so we can attach cache-control. `Response.redirect()`
      // doesn't accept extra headers.
      return new Response(null, {
        status: 302,
        headers: {
          location: target,
          "cache-control": "no-store",
        },
      });
    }

    case "html": {
      const html =
        typeof payload.p === "object" && payload.p !== null
          ? (payload.p as { html?: unknown }).html
          : undefined;
      const body =
        typeof html === "string"
          ? html
          : "<!doctype html><html><body></body></html>";
      return new Response(body, {
        status: 200,
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "content-security-policy": HTML_CSP,
        },
      });
    }

    case "gif":
    default:
      return gifResponse();
  }
}

function gifResponse(): Response {
  return new Response(gifBytes(), {
    status: 200,
    headers: {
      "content-type": "image/gif",
      "cache-control": "no-store",
    },
  });
}
