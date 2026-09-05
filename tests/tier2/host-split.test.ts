import { describe, expect, it } from "vitest";
import { seedCanaryKey } from "../integration/_harness";
import { DASHBOARD_HOST, PUBLIC_HOST, rawRequest } from "./_client";

// Tier-2: proves the proxy host-split (src/proxy.ts) is actually APPLIED by
// the production runtime — matcher wiring included — not just that
// publicOnlyDecision() returns the right answer (tests/proxy.test.ts covers
// the decision matrix at unit level). This is the tier that would have caught
// GHSA-6gpp-xcg3-4w24 (Next middleware/proxy bypass under Turbopack): a
// runtime that silently skips the proxy passes every unit test and fails here.
//
// The server under test runs with PUBLIC_ONLY_HOSTS / DASHBOARD_HOSTS set
// (scripts/test-tier2.sh); requests steer the gate via the Host header alone.

describe("proxy host-split (runtime-applied)", () => {
  it("blocks dashboard pages on the public-only host with the gate's 404", async () => {
    const res = await rawRequest("/keys", { host: PUBLIC_HOST });
    expect(res.status).toBe(404);
    // The gate's own response, not the app's HTML not-found page: empty body
    // with Cache-Control: no-store (src/proxy.ts).
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body).toBe("");
  });

  it("blocks the management API on the public-only host BEFORE auth runs", async () => {
    const publicRes = await rawRequest("/api/keys", { host: PUBLIC_HOST });
    expect(publicRes.status).toBe(404);
    expect(publicRes.body).toBe("");

    // Control: the identical unauthenticated request on the dashboard host
    // reaches the route handler and gets its 401 — so the 404 above came from
    // the proxy (and the matcher does include /api/*), not from the handler.
    const dashRes = await rawRequest("/api/keys", { host: DASHBOARD_HOST });
    expect(dashRes.status).toBe(401);
  });

  it("still serves the public trigger on the public-only host", async () => {
    const key = await seedCanaryKey(null);
    const res = await rawRequest(`/c/${key.publicId}`, { host: PUBLIC_HOST });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("image/gif");
  });

  it("serves generated URLs with the configured public prefix", async () => {
    const key = await seedCanaryKey(null);
    const prefix = (process.env.MANTIS_PUBLIC_PATH ?? "/c").replace(/\/+$/, "");
    const path = prefix.startsWith("/") ? prefix : `/${prefix}`;
    const res = await rawRequest(`${path}/${key.publicId}?source=launch-test`, { host: PUBLIC_HOST });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("image/gif");
    expect(res.headers["cache-control"]).toContain("no-store");
  });

  it("preserves the HTML sandbox on custom trigger URLs", async () => {
    const key = await seedCanaryKey(null, {
      responseKind: "html", responsePayload: { html: "<p>canary</p>" },
    });
    const prefix = (process.env.MANTIS_PUBLIC_PATH ?? "/c").replace(/\/+$/, "");
    const path = prefix.startsWith("/") ? prefix : `/${prefix}`;
    const res = await rawRequest(`${path}/${key.publicId}`, { host: PUBLIC_HOST });
    expect(res.status).toBe(200);
    expect(res.headers["content-security-policy"]).toContain("sandbox");
    expect(res.body).toBe("<p>canary</p>");
  });

  it("fails closed on an unknown Host: dashboard blocked, public paths served", async () => {
    // No host override → Host is 127.0.0.1:<port>, in neither configured list.
    const blocked = await rawRequest("/keys");
    expect(blocked.status).toBe(404);
    expect(blocked.body).toBe("");

    const key = await seedCanaryKey(null);
    const allowed = await rawRequest(`/c/${key.publicId}`);
    expect(allowed.status).toBe(200);
  });

  it("gates /api/health on the public host unless explicitly allowed", async () => {
    // PUBLIC_ONLY_ALLOW_HEALTH is unset for the server under test.
    const publicRes = await rawRequest("/api/health", { host: PUBLIC_HOST });
    expect(publicRes.status).toBe(404);

    const dashRes = await rawRequest("/api/health", { host: DASHBOARD_HOST });
    expect(dashRes.status).toBe(200);
    expect(dashRes.body).toContain('"db":"ok"');
  });

  it("serves the dashboard normally on the dashboard host", async () => {
    const res = await rawRequest("/login", { host: DASHBOARD_HOST });
    expect(res.status).toBe(200);
    expect(res.body).toContain("api_key");
  });
});
