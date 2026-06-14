import { describe, expect, it } from "vitest";
import type { NextRequest } from "next/server";
import {
  BodyParseError,
  BodyTooLargeError,
  readBodyJson,
  readBodyText,
} from "@/lib/safe-body";

/**
 * NextRequest is structurally compatible enough with `globalThis.Request`
 * that we can substitute one for tests — both expose `.body` as a
 * ReadableStream<Uint8Array> and `.headers.get(...)`. The cast keeps the
 * type checker happy without pulling in the next/server runtime here.
 */
type AnyReq = NextRequest;
function makeReq(body: string | Uint8Array, headers: Record<string, string> = {}): AnyReq {
  const init: RequestInit = { method: "POST", body: body as BodyInit, headers };
  return new Request("https://example.test/p", init) as unknown as AnyReq;
}

function makeStreamingReq(
  chunks: Uint8Array[],
  headers: Record<string, string> = {},
): AnyReq {
  // ReadableStream chunked body — exercises the streaming-loop branch
  // (the body() path that aggregates value-by-value), which is the path
  // that actually enforces the cap mid-stream.
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
  });
  return new Request("https://example.test/p", {
    method: "POST",
    body: stream,
    headers,
    // @ts-expect-error — undici needs this for streamed bodies.
    duplex: "half",
  }) as unknown as AnyReq;
}

describe("readBodyText", () => {
  it("returns the body when under the cap", async () => {
    const req = makeReq("hello world");
    expect(await readBodyText(req, 1024)).toBe("hello world");
  });

  it("throws BodyTooLargeError when content-length exceeds the cap (early reject)", async () => {
    // Synthesise a Content-Length that lies upward — past the cap. The
    // reader should bail before reading even one byte.
    const req = makeReq("x".repeat(100), { "content-length": "1000000" });
    await expect(readBodyText(req, 1024)).rejects.toBeInstanceOf(
      BodyTooLargeError,
    );
  });

  it("throws BodyTooLargeError when the streamed body grows past the cap", async () => {
    // No content-length header — the streaming counter must catch it.
    const chunk = new Uint8Array(2048);
    chunk.fill(0x41); // ASCII 'A'
    const req = makeStreamingReq([chunk, chunk, chunk]); // 6 KiB total
    await expect(readBodyText(req, 4096)).rejects.toBeInstanceOf(
      BodyTooLargeError,
    );
  });

  it("returns empty string for an empty body", async () => {
    const req = makeReq("");
    expect(await readBodyText(req, 1024)).toBe("");
  });
});

describe("readBodyJson", () => {
  it("parses valid JSON within the cap", async () => {
    const req = makeReq(JSON.stringify({ a: 1, b: "two" }));
    const parsed = await readBodyJson<{ a: number; b: string }>(req, 1024);
    expect(parsed).toEqual({ a: 1, b: "two" });
  });

  it("throws BodyParseError for an empty body", async () => {
    const req = makeReq("");
    await expect(readBodyJson(req, 1024)).rejects.toBeInstanceOf(
      BodyParseError,
    );
  });

  it("throws BodyParseError for malformed JSON", async () => {
    const req = makeReq("{ not json");
    await expect(readBodyJson(req, 1024)).rejects.toBeInstanceOf(
      BodyParseError,
    );
  });

  it("throws BodyTooLargeError ahead of JSON parsing when oversized", async () => {
    // The text-level cap fires first, so we never even try to parse the
    // (potentially nonsense) bytes. This is the behaviour route handlers
    // rely on to map to HTTP 413 vs 400 cleanly.
    const big = "x".repeat(2048);
    const req = makeReq(big);
    await expect(readBodyJson(req, 1024)).rejects.toBeInstanceOf(
      BodyTooLargeError,
    );
  });

  it("preserves the BodyTooLargeError.maxBytes for downstream messaging", async () => {
    const req = makeReq("x".repeat(2048));
    try {
      await readBodyJson(req, 1024);
      expect.fail("expected BodyTooLargeError");
    } catch (err) {
      expect(err).toBeInstanceOf(BodyTooLargeError);
      expect((err as BodyTooLargeError).maxBytes).toBe(1024);
    }
  });
});
