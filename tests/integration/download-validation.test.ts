import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";
import { db } from "@/db/client";
import { keys } from "@/db/schema";
import { MAX_API_JSON_BYTES } from "@/lib/safe-body";
import { seedApiKey, seedCanaryKey } from "./_harness";

vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
  cookies: async () => ({ get: () => undefined }),
}));
vi.mock("@/lib/log", () => ({
  log: { info() {}, warn() {}, error() {}, debug() {} },
}));

import { POST as bulkDownload } from "@/app/api/keys/bulk-download/route";
import { POST as deviceBundle } from "@/app/api/keys/device-bundle/route";

function request(bearer: string, body: unknown): NextRequest {
  return new NextRequest("http://localhost:3000/api/keys/download", {
    method: "POST",
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const endpoints = [
  { name: "bulk download", post: bulkDownload, body: (id: string) => ({ ids: [id], format: "md" }) },
  {
    name: "device bundle", post: deviceBundle,
    body: (id: string) => ({ device: "test laptop", os: "linux", vectors: [{ id, slug: "boot" }] }),
  },
];

describe.each(endpoints)("$name input validation", ({ post, body }) => {
  it.each(["not-a-uuid", "", "00000000-0000-0000-0000"])("rejects malformed ID %j", async (id) => {
    const owner = await seedApiKey();
    const res = await post(request(owner.plaintext, body(id)));
    expect(res.status).toBe(400);
  });

  it("rejects an oversized streamed JSON body", async () => {
    const owner = await seedApiKey();
    const key = await seedCanaryKey(owner.row.id);
    const res = await post(request(owner.plaintext, {
      ...body(key.id), padding: "x".repeat(MAX_API_JSON_BYTES),
    }));
    expect(res.status).toBe(413);
  });

  it("accepts a valid uppercase UUID", async () => {
    const owner = await seedApiKey();
    const key = await seedCanaryKey(owner.row.id, {
      id: "abcdef01-2345-4678-9abc-def012345678",
    });
    const res = await post(request(owner.plaintext, body(key.id.toUpperCase())));
    expect(res.status).toBe(200);
  });

  it("rejects invalid JSON with a client error", async () => {
    const owner = await seedApiKey();
    const req = new NextRequest("http://localhost:3000/api/keys/download", {
      method: "POST",
      headers: { authorization: `Bearer ${owner.plaintext}`, "content-type": "application/json" },
      body: "{broken",
    });
    expect((await post(req)).status).toBe(400);
  });
});

describe("bulk download attribution", () => {
  it("records the first downloaded format and preserves it on later downloads", async () => {
    const owner = await seedApiKey();
    const key = await seedCanaryKey(owner.row.id);
    for (const format of ["md", "svg"]) {
      const res = await bulkDownload(request(owner.plaintext, { ids: [key.id], format }));
      expect(res.status).toBe(200);
      const [row] = await db.select().from(keys).where(eq(keys.id, key.id));
      expect(row!.firstDownloadFormat).toBe("md");
    }
  });
});
