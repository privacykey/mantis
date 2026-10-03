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
import { GET as captureGet, POST as capturePost } from "@/app/inbox/[...slug]/route";
import { pushCapture, clearCaptures, type Capture } from "@/lib/inbox";
import { seedApiKey, buildJsonRequest } from "./_harness";

const SECRET = "supersecret-captured-webhook-body-42";

function capture(): void {
  pushCapture({
    method: "POST",
    slug: "demo",
    url: "http://localhost:3000/inbox/demo",
    headers: { "x-webhook-id": SECRET },
    body: JSON.stringify({ token: SECRET }),
    body_truncated: false,
  });
}

const slugCtx = (slug: string[]) => ({ params: Promise.resolve({ slug }) });

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

  it("never stores ambient credentials: cookie/authorization are captured as [redacted]", async () => {
    // /inbox/* shares the dashboard origin, so a browser navigation there (a
    // link, a redirect-kind canary) carries the operator's session cookie; an
    // access proxy adds its own assertions. None of it may reach the buffer,
    // which every full-scope principal — admin or not — can read back.
    const SESSION = "mantis_sess_ADMIN-SESSION-TOKEN-do-not-store";
    const nav = await captureGet(
      buildJsonRequest("/inbox/lure", {
        headers: {
          cookie: `theme=dark; mantis_session=${SESSION}`,
          "sec-fetch-mode": "navigate",
          "cf-access-jwt-assertion": `jwt.${SESSION}`,
        },
      }),
      slugCtx(["lure"]),
    );
    expect(nav.status).toBe(200);

    const hook = await capturePost(
      buildJsonRequest("/inbox/hook", {
        method: "POST",
        bearer: SESSION,
        body: { event: "mantis.hit" },
        headers: {
          "proxy-authorization": `Basic ${SESSION}`,
          "x-api-key": SESSION,
          "x-mantis-signature": "t=1,v1=abcdef",
        },
      }),
      slugCtx(["hook"]),
    );
    expect(hook.status).toBe(200);

    const reader = await seedApiKey(); // non-admin, full scope
    const res = await inboxGet(
      buildJsonRequest("/api/inbox", { bearer: reader.plaintext }),
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(SESSION);

    const { data } = JSON.parse(text) as { data: Capture[] };
    const byslug = Object.fromEntries(data.map((c) => [c.slug, c]));
    // The header NAMES survive, so the operator can see what was sent…
    expect(byslug.lure!.headers.cookie).toBe("[redacted]");
    expect(byslug.lure!.headers["cf-access-jwt-assertion"]).toBe("[redacted]");
    expect(byslug.hook!.headers.authorization).toBe("[redacted]");
    expect(byslug.hook!.headers["proxy-authorization"]).toBe("[redacted]");
    expect(byslug.hook!.headers["x-api-key"]).toBe("[redacted]");
    // …and everything a webhook debugger needs is untouched.
    expect(byslug.lure!.headers["sec-fetch-mode"]).toBe("navigate");
    expect(byslug.hook!.headers["x-mantis-signature"]).toBe("t=1,v1=abcdef");
    expect(byslug.hook!.headers["content-type"]).toBe("application/json");
    expect(byslug.hook!.body).toBe(JSON.stringify({ event: "mantis.hit" }));
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
