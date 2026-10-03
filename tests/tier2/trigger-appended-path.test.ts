import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { hits } from "@/db/schema";
import { seedCanaryKey } from "../integration/_harness";
import { DASHBOARD_HOST, PUBLIC_HOST, rawRequest } from "./_client";

// Tier-2: a bait URL in a base-URL field (aws endpoint_url, API_BASE_URL,
// kubeconfig server) is hit with a path APPENDED by the consuming tool, any
// method, sometimes just a trailing slash. Whether those requests reach the
// hit recorder is decided by the runtime — Next's route matching, its built-in
// trailing-slash redirect, and the proxy rewrite — so only a served build can
// prove it. Handler-level behaviour is covered in
// tests/integration/trigger-suppression.test.ts.

const prefix = (() => {
  const raw = (process.env.MANTIS_PUBLIC_PATH ?? "/c").trim().replace(/\/+$/, "");
  return raw.startsWith("/") ? raw : `/${raw}`;
})();

async function seedJsonKey() {
  return seedCanaryKey(null, {
    responseKind: "json",
    responsePayload: { ok: true },
    dedupeWindowSeconds: 0,
  });
}

async function hitRows(keyId: string) {
  return db.select().from(hits).where(eq(hits.keyId, keyId));
}

const requestPaths = (rows: Awaited<ReturnType<typeof hitRows>>) =>
  rows
    .map((r) => (r.headers as Record<string, string> | null)?.["x-mantis-request-path"])
    .filter((p): p is string => typeof p === "string")
    .sort();

describe("trigger URL with an appended path (runtime-applied)", () => {
  it("records a hit on /c/<id>/<path> for every method, with the key's own response", async () => {
    const key = await seedJsonKey();
    const calls: Array<[string, string]> = [
      ["GET", `/c/${key.publicId}/example-prod-uploads?list-type=2&encoding-type=url`],
      ["HEAD", `/c/${key.publicId}/example-prod-uploads/backup.sql`],
      ["PUT", `/c/${key.publicId}/example-prod-uploads/new.txt`],
      ["DELETE", `/c/${key.publicId}/example-prod-uploads/new.txt`],
      ["POST", `/c/${key.publicId}/2015-03-31/functions`],
      ["PATCH", `/c/${key.publicId}/v1/users/7`],
    ];
    for (const [method, path] of calls) {
      const res = await rawRequest(path, { method, host: PUBLIC_HOST });
      expect(res.status, `${method} ${path}`).toBe(200);
      expect(res.headers["content-type"], method).toContain("application/json");
      if (method !== "HEAD") expect(JSON.parse(res.body), method).toEqual({ ok: true });
    }

    const rows = await hitRows(key.id);
    expect(rows).toHaveLength(calls.length);
    expect(requestPaths(rows)).toEqual(
      [
        "/2015-03-31/functions",
        "/example-prod-uploads",
        "/example-prod-uploads/backup.sql",
        "/example-prod-uploads/new.txt",
        "/example-prod-uploads/new.txt",
        "/v1/users/7",
      ].sort(),
    );
  });

  it("records a hit under the configured MANTIS_PUBLIC_PATH prefix as well", async () => {
    const key = await seedJsonKey();
    const get = await rawRequest(`${prefix}/${key.publicId}/restapis?limit=25`, {
      host: PUBLIC_HOST,
    });
    expect(get.status).toBe(200);
    expect(JSON.parse(get.body)).toEqual({ ok: true });

    const put = await rawRequest(`${prefix}/${key.publicId}/bucket/object.bin`, {
      method: "PUT",
      host: PUBLIC_HOST,
      body: "payload",
      headers: { "content-length": "7" },
    });
    expect(put.status).toBe(200);

    const rows = await hitRows(key.id);
    expect(rows).toHaveLength(2);
    expect(requestPaths(rows)).toEqual(["/bucket/object.bin", "/restapis"]);
  });

  it("serves <trigger URL>/ directly — no redirect a tool would not follow", async () => {
    const key = await seedJsonKey();
    const paths = [
      `/c/${key.publicId}/`,
      `${prefix}/${key.publicId}/`,
      `${prefix}/${key.publicId}/health/`,
    ];
    for (const path of paths) {
      const res = await rawRequest(path, { host: PUBLIC_HOST });
      expect(res.status, path).toBe(200);
      expect(res.headers.location, path).toBeUndefined();
      expect(JSON.parse(res.body), path).toEqual({ ok: true });
    }
    expect(await hitRows(key.id)).toHaveLength(paths.length);

    // …for the other methods as well, on the bare URL and with the slash.
    const others: Array<[string, string]> = [
      ["PUT", `/c/${key.publicId}/`],
      ["DELETE", `${prefix}/${key.publicId}/`],
      ["PATCH", `/c/${key.publicId}`],
      ["DELETE", `${prefix}/${key.publicId}`],
    ];
    for (const [method, path] of others) {
      const res = await rawRequest(path, { method, host: PUBLIC_HOST });
      expect(res.status, `${method} ${path}`).toBe(200);
      expect(JSON.parse(res.body), `${method} ${path}`).toEqual({ ok: true });
    }
    expect(await hitRows(key.id)).toHaveLength(paths.length + others.length);
  });

  it("is no existence oracle: unknown and disabled ids answer like the bare URL", async () => {
    const disabled = await seedCanaryKey(null, {
      responseKind: "json",
      responsePayload: { ok: true },
      disabledAt: new Date(),
    });
    for (const id of ["unknownid9", disabled.publicId]) {
      const bare = await rawRequest(`/c/${id}`, { host: PUBLIC_HOST });
      for (const path of [`/c/${id}/health`, `/c/${id}/`, `${prefix}/${id}/a/b`]) {
        const res = await rawRequest(path, { host: PUBLIC_HOST });
        expect(res.status, path).toBe(bare.status);
        expect(res.headers["content-type"], path).toBe(bare.headers["content-type"]);
        expect(res.body, path).toBe(bare.body);
      }
      expect(bare.headers["content-type"]).toContain("image/gif");
    }
    expect(await db.select().from(hits)).toHaveLength(0);
  });

  it("keeps the trigger's own response headers on appended paths", async () => {
    const key = await seedJsonKey();
    for (const path of [`/c/${key.publicId}`, `/c/${key.publicId}/v1/users`]) {
      const res = await rawRequest(path, { host: PUBLIC_HOST });
      expect(res.status, path).toBe(200);
      // No dashboard framing/CSP headers on the public trigger.
      expect(res.headers["x-frame-options"], path).toBeUndefined();
      expect(res.headers["content-security-policy"], path).toBeUndefined();
      expect(res.headers["x-content-type-options"], path).toBe("nosniff");
      expect(res.headers["cache-control"], path).toContain("no-store");
    }
  });
});

describe("trailing-slash handling outside the trigger (runtime-applied)", () => {
  it("still 308s dashboard paths to their slash-less form, path-relative", async () => {
    const page = await rawRequest("/login/?next=%2Fkeys", { host: DASHBOARD_HOST });
    expect(page.status).toBe(308);
    expect(page.headers.location).toBe("/login?next=%2Fkeys");

    const api = await rawRequest("/api/health/", { host: DASHBOARD_HOST });
    expect(api.status).toBe(308);
    expect(api.headers.location).toBe("/api/health");

    // …and the slash-less form is served as before.
    expect((await rawRequest("/login", { host: DASHBOARD_HOST })).status).toBe(200);
  });

  it("does not open the management surface on the public-only host", async () => {
    for (const path of ["/keys/", "/api/keys/", "/login/"]) {
      const res = await rawRequest(path, { host: PUBLIC_HOST });
      expect(res.status, path).toBe(404);
      expect(res.body, path).toBe("");
      expect(res.headers.location, path).toBeUndefined();
    }
    // A path that merely contains a key id is not a trigger URL.
    const key = await seedJsonKey();
    const res = await rawRequest(`/api/keys/${key.publicId}/hits`, { host: PUBLIC_HOST });
    expect(res.status).toBe(404);
    expect(await hitRows(key.id)).toHaveLength(0);
  });
});
