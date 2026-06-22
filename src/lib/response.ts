import { NextResponse } from "next/server";
import type { ResponseKind } from "@/db/schema";

const TRANSPARENT_GIF = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
  "base64",
);

const NO_STORE: HeadersInit = {
  "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
  Pragma: "no-cache",
};

// Operator-supplied HTML is served from the dashboard origin. The bare
// `sandbox` token (no allow-* flags) is the real boundary: it drops the
// document into a unique opaque origin, so embedded markup can't read the
// dashboard's cookies/storage or run script even if the rest of the policy
// regressed. default-src 'none' + form-action/base-uri 'none' close the
// remaining vectors. NEVER add allow-same-origin / allow-scripts here.
// (A fully separate content origin is the stronger, ops-level upgrade —
// host operator content on its own hostname; see docs.)
const HTML_CSP =
  "default-src 'none'; img-src https: data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; sandbox";

function isHttpUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

export function buildTriggerResponse(
  kind: ResponseKind,
  payload: unknown,
): Response {
  switch (kind) {
    case "gif": {
      const bytes = new Uint8Array(TRANSPARENT_GIF);
      return new Response(bytes, {
        status: 200,
        headers: {
          ...NO_STORE,
          "Content-Type": "image/gif",
          "Content-Length": String(bytes.byteLength),
        },
      });
    }
    case "empty":
      return new Response(null, { status: 204, headers: NO_STORE });
    case "json": {
      const body = payload ?? { ok: true };
      return NextResponse.json(body, { status: 200, headers: NO_STORE });
    }
    case "redirect": {
      const url =
        typeof payload === "object" &&
        payload !== null &&
        "url" in payload &&
        typeof (payload as { url: unknown }).url === "string"
          ? (payload as { url: string }).url
          : null;
      // Refuse non-http(s) schemes even though the validator blocks them on
      // write — old DB rows may still carry javascript:/data: URLs.
      if (!url || !isHttpUrl(url)) return buildTriggerResponse("gif", null);
      return new Response(null, {
        status: 302,
        headers: { ...NO_STORE, Location: url },
      });
    }
    case "html": {
      const html =
        typeof payload === "object" &&
        payload !== null &&
        "html" in payload &&
        typeof (payload as { html: unknown }).html === "string"
          ? (payload as { html: string }).html
          : "<!doctype html><meta charset=utf-8><title></title>";
      return new Response(html, {
        status: 200,
        headers: {
          ...NO_STORE,
          "Content-Type": "text/html; charset=utf-8",
          "Content-Security-Policy": HTML_CSP,
          // Defense-in-depth around the sandbox: don't let the browser sniff
          // a different type, and refuse cross-origin embedding of this
          // operator-controlled content.
          "X-Content-Type-Options": "nosniff",
          "Cross-Origin-Resource-Policy": "same-origin",
        },
      });
    }
  }
}
