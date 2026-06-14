// Body readers that fail closed past a configurable byte cap.
//
// Why this exists: Next.js (and Node) don't apply a strict body-size limit
// to `req.json()` / `req.text()`. A hostile (or buggy) client can stream a
// multi-GB body and pin the process while we wait. The wrappers below
// stream the body through a counter and reject once we've absorbed
// `maxBytes` — before the resulting buffer ever lands in V8 as a string.
//
// Use the typed errors so route handlers can map to the right HTTP code:
//   BodyTooLargeError → 413
//   BodyParseError    → 400

import type { NextRequest } from "next/server";

export class BodyTooLargeError extends Error {
  readonly maxBytes: number;
  constructor(maxBytes: number) {
    super(`request body exceeded ${maxBytes} bytes`);
    this.name = "BodyTooLargeError";
    this.maxBytes = maxBytes;
  }
}

export class BodyParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BodyParseError";
  }
}

/** Read at most `maxBytes` of body as a UTF-8 string. Throws on overflow. */
export async function readBodyText(
  req: NextRequest,
  maxBytes: number,
): Promise<string> {
  // Quick-reject obviously-too-big requests on the declared Content-Length
  // so we don't even start streaming. Clients may lie or omit it; the
  // streaming loop below catches anything that slips through.
  const declared = req.headers.get("content-length");
  if (declared) {
    const n = Number(declared);
    if (Number.isFinite(n) && n > maxBytes) {
      throw new BodyTooLargeError(maxBytes);
    }
  }

  const reader = req.body?.getReader();
  if (!reader) return "";

  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      // Stop pulling. The kernel will eventually shut the connection; we
      // don't have to drain.
      try {
        await reader.cancel();
      } catch {
        /* best-effort */
      }
      throw new BodyTooLargeError(maxBytes);
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    buf.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(buf);
}

/** Read at most `maxBytes` of body and parse as JSON. */
export async function readBodyJson<T = unknown>(
  req: NextRequest,
  maxBytes: number,
): Promise<T> {
  const raw = await readBodyText(req, maxBytes);
  if (raw.length === 0) {
    throw new BodyParseError("empty body");
  }
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    throw new BodyParseError(
      err instanceof Error ? err.message : "invalid JSON",
    );
  }
}

// Conventional caps. Tune per route — these are sane upper bounds, not the
// expected size of any one body. Routes that accept structured commands
// should never need more than a few KB; the inbox capture grabs whatever
// the webhook sender posted and is sized for that.
export const MAX_API_JSON_BYTES = 64 * 1024; // 64 KiB
export const MAX_WEBHOOK_LOG_BYTES = 32 * 1024; // 32 KiB
export const MAX_INBOX_CAPTURE_BYTES = 1 * 1024 * 1024; // 1 MiB
