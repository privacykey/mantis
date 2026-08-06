import { describe, it, expect, vi } from "vitest";

// Bulk artifact download (/api/keys/bulk-download): the endpoint takes an
// arbitrary list of key ids, so the authorization boundary is the whole story.
// A caller must never receive — or be able to infer the existence of — a key
// belonging to someone else.

vi.mock("@/lib/log", () => ({
  log: { info() {}, warn() {}, error() {}, debug() {}, fatal() {}, trace() {} },
}));

vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
}));

import { POST } from "@/app/api/keys/bulk-download/route";
import { NextRequest } from "next/server";
import { seedApiKey, seedCanaryKey } from "./_harness";

function buildRequest(bearer: string, body: unknown): NextRequest {
  return new NextRequest("http://localhost:3000/api/keys/bulk-download", {
    method: "POST",
    headers: {
      authorization: `Bearer ${bearer}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

describe("bulk artifact download", () => {
  it("returns a zip of one artifact per owned key", async () => {
    const owner = await seedApiKey();
    const a = await seedCanaryKey(owner.row.id, { memo: "finance share" });
    const b = await seedCanaryKey(owner.row.id, { memo: "hr share" });

    const res = await POST(
      buildRequest(owner.plaintext, { ids: [a.id, b.id], format: "docx" }),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    expect(res.headers.get("content-disposition")).toContain(".zip");
    const buf = Buffer.from(await res.arrayBuffer());
    // PK zip magic — proves a real archive, not an error body.
    expect(buf.subarray(0, 2).toString()).toBe("PK");
    expect(buf.length).toBeGreaterThan(1000);
  });

  it("hides another tenant's keys as 404, not 403", async () => {
    // 403 would confirm the id exists. 404 keeps key ids unprobeable.
    const owner = await seedApiKey();
    const other = await seedApiKey({ name: "tenant-b" });
    const key = await seedCanaryKey(owner.row.id, { memo: "secret" });

    const res = await POST(
      buildRequest(other.plaintext, { ids: [key.id], format: "docx" }),
    );

    expect(res.status).toBe(404);
  });

  it("returns only the caller's keys when ids are mixed", async () => {
    const owner = await seedApiKey();
    const other = await seedApiKey({ name: "tenant-b" });
    const mine = await seedCanaryKey(other.row.id, { memo: "mine" });
    const theirs = await seedCanaryKey(owner.row.id, { memo: "theirs" });

    const res = await POST(
      buildRequest(other.plaintext, {
        ids: [mine.id, theirs.id],
        format: "md",
      }),
    );

    expect(res.status).toBe(200);
    const text = Buffer.from(await res.arrayBuffer()).toString("latin1");
    // The manifest lists every included key; the other tenant's must be absent.
    expect(text).toContain("mine");
    expect(text).not.toContain("theirs");
  });

  it("lets an admin fetch keys created by others", async () => {
    const admin = await seedApiKey({ admin: true });
    const user = await seedApiKey({ name: "user" });
    const key = await seedCanaryKey(user.row.id, { memo: "user key" });

    const res = await POST(
      buildRequest(admin.plaintext, { ids: [key.id], format: "docx" }),
    );

    expect(res.status).toBe(200);
  });

  it.each<{ label: string; body: unknown }>([
    { label: "empty ids", body: { ids: [], format: "docx" } },
    {
      label: "path-ish format",
      body: { ids: ["not-a-uuid"], format: "../../etc/passwd" },
    },
    { label: "non-string ids", body: { ids: [123], format: "docx" } },
    { label: "missing ids", body: { format: "docx" } },
  ])("rejects bad input: $label", async ({ body }) => {
    const owner = await seedApiKey();
    const res = await POST(buildRequest(owner.plaintext, body));
    expect(res.status).toBe(400);
  });

  it("caps the batch size", async () => {
    const owner = await seedApiKey();
    const res = await POST(
      buildRequest(owner.plaintext, {
        ids: Array.from({ length: 51 }, () => crypto.randomUUID()),
        format: "docx",
      }),
    );
    expect(res.status).toBe(400);
  });

  it("requires authentication", async () => {
    const req = new NextRequest("http://localhost:3000/api/keys/bulk-download", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids: [crypto.randomUUID()], format: "docx" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(401);
  });
});
