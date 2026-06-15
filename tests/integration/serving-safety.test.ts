import { describe, it, expect, vi } from "vitest";

// E2E-10 — Stored response_payload is served safely at /c. Valid redirect/html
// payloads get the right status + CSP, and a poisoned legacy javascript: redirect
// row (a stored-XSS / open-redirect vector) is refused at serve time even though
// the write-side validator would have blocked it.

vi.mock("@/lib/log", () => ({
  log: { info() {}, warn() {}, error() {}, debug() {}, fatal() {}, trace() {} },
}));
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return { ...actual, after: (_fn: unknown) => {} };
});

import { GET as trigger } from "@/app/c/[publicId]/route";
import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { keys } from "@/db/schema";
import { seedApiKey, seedCanaryKey, ctxParams } from "./_harness";

function hit(publicId: string): Promise<Response> {
  const req = new NextRequest(new URL(`http://localhost:3000/c/${publicId}`), {
    method: "GET",
    headers: new Headers({ "user-agent": "it-serve" }),
  });
  return trigger(req, ctxParams({ publicId }));
}

describe("E2E-10 stored payload serving safety", () => {
  it("serves a valid redirect as a 302 with no-store", async () => {
    const owner = await seedApiKey();
    await seedCanaryKey(owner.row.id, {
      publicId: "redir00001",
      responseKind: "redirect",
      responsePayload: { url: "https://example.com/landing" },
    });
    const res = await hit("redir00001");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://example.com/landing");
    expect(res.headers.get("cache-control")).toContain("no-store");
  });

  it("serves stored HTML under a strict sandboxing CSP", async () => {
    const owner = await seedApiKey();
    await seedCanaryKey(owner.row.id, {
      publicId: "htmlkey001",
      responseKind: "html",
      responsePayload: { html: "<h1>decoy</h1>" },
    });
    const res = await hit("htmlkey001");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("sandbox");
  });

  it("refuses a poisoned javascript: redirect row (falls back to silent GIF)", async () => {
    const owner = await seedApiKey();
    const key = await seedCanaryKey(owner.row.id, {
      publicId: "poison0001",
      responseKind: "redirect",
      responsePayload: { url: "https://example.com/ok" },
    });
    // Simulate a legacy/poisoned row the validator would reject on write.
    await db
      .update(keys)
      .set({ responsePayload: { url: "javascript:alert(1)" } })
      .where(eq(keys.id, key.id));

    const res = await hit("poison0001");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/gif");
    expect(res.headers.get("location")).toBeNull();
  });
});
