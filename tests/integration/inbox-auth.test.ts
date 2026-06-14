import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// E2E-06 — Dev inbox auth gate (commit 4846c552). The capture endpoint is
// unauthenticated by design, but READING/CLEARING the buffer must require
// operator auth (the hole the fix closed), and every inbox surface must 404
// when ENABLE_DEV_INBOX is off — before auth is even considered.

vi.mock("@/lib/log", () => ({
  log: { info() {}, warn() {}, error() {}, debug() {}, fatal() {}, trace() {} },
}));
// No session cookie present ⇒ getSessionApiKey() resolves to null instead of
// throwing on cookies() outside a request scope.
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
  headers: async () => ({ get: () => null }),
}));

import { GET as inboxGet, DELETE as inboxDelete } from "@/app/api/inbox/route";
import { pushCapture, clearCaptures } from "@/lib/inbox";
import { seedApiKey, buildJsonRequest } from "./_harness";

const SECRET = "supersecret-captured-webhook-body-42";

function capture(): void {
  pushCapture({
    method: "POST",
    slug: "demo",
    url: "http://localhost:3000/inbox/demo",
    headers: { "x-secret": SECRET },
    body: JSON.stringify({ token: SECRET }),
    body_truncated: false,
  });
}

beforeEach(() => {
  clearCaptures();
  process.env.ENABLE_DEV_INBOX = "1";
});

afterEach(() => {
  clearCaptures();
  delete process.env.ENABLE_DEV_INBOX;
});

describe("E2E-06 dev inbox auth gate", () => {
  it("anonymous read/clear are rejected and never leak captured bodies", async () => {
    capture();

    const get = await inboxGet(buildJsonRequest("/api/inbox"));
    expect(get.status).toBe(401);
    expect(await get.text()).not.toContain(SECRET);

    const del = await inboxDelete(
      buildJsonRequest("/api/inbox", { method: "DELETE" }),
    );
    expect(del.status).toBe(401);
  });

  it("an authenticated operator can read then clear the buffer", async () => {
    const op = await seedApiKey();
    capture();

    const get = await inboxGet(
      buildJsonRequest("/api/inbox", { bearer: op.plaintext }),
    );
    expect(get.status).toBe(200);
    const body = (await get.json()) as { data: unknown[] };
    expect(body.data.length).toBe(1);
    expect(JSON.stringify(body.data)).toContain(SECRET);

    const del = await inboxDelete(
      buildJsonRequest("/api/inbox", { method: "DELETE", bearer: op.plaintext }),
    );
    expect(del.status).toBe(204);

    const after = await inboxGet(
      buildJsonRequest("/api/inbox", { bearer: op.plaintext }),
    );
    const afterBody = (await after.json()) as { data: unknown[] };
    expect(afterBody.data.length).toBe(0);
  });

  it("all inbox surfaces 404 when the feature flag is off — even with a valid key", async () => {
    delete process.env.ENABLE_DEV_INBOX;
    const op = await seedApiKey();
    capture();

    const get = await inboxGet(
      buildJsonRequest("/api/inbox", { bearer: op.plaintext }),
    );
    expect(get.status).toBe(404);

    const del = await inboxDelete(
      buildJsonRequest("/api/inbox", { method: "DELETE", bearer: op.plaintext }),
    );
    expect(del.status).toBe(404);
  });
});
