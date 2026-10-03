import { describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
const session = vi.hoisted(() => ({ id: "" }));
vi.mock("@/lib/session", () => ({ getSessionApiKey: async () => ({ id: session.id, isAdmin: false }) }));
vi.mock("@/lib/log", () => ({ log: { info() {}, warn() {}, error() {}, debug() {} } }));
// The device action records its audit rows with the caller's IP.
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
import { db } from "@/db/client";
import { keys } from "@/db/schema";
import { GET as listKeys } from "@/app/api/keys/route";
import { deviceCreateAction } from "@/app/(app)/keys/device/actions";
import { deviceExternalId, getDeviceProfile } from "@mantis/core/device-profiles";
import { buildJsonRequest, seedApiKey, seedCanaryKey } from "./_harness";

describe("server completion", () => {
  it("rolls back all new device vectors when a selected vector belongs to another account", async () => {
    const first = await seedApiKey(); const second = await seedApiKey();
    session.id = second.row.id;
    const vectors = getDeviceProfile("linux").vectors.slice(0, 2);
    const existing = await seedCanaryKey(first.row.id, { externalId: deviceExternalId("shared-host", "linux", vectors[0]!) });
    const form = new FormData(); form.set("os", "linux"); form.set("device", "shared-host");
    for (const vector of vectors) form.append("vectors", vector.slug);
    const result = await deviceCreateAction({}, form);
    expect(result.error).toMatch(/already in use/);
    expect(result.minted).toBeUndefined();
    expect((await db.select().from(keys)).map((key) => key.id)).toEqual([existing.id]);
  });

  it("paginates a tied batch with full database precision and accepts legacy timestamps", async () => {
    const owner = await seedApiKey();
    const ids = [1, 2, 3, 4].map((n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`);
    await db.insert(keys).values(ids.map((id, index) => ({ id, publicId: `keybatch${index}`, memo: `bulk ${index}`, createdByApiKeyId: owner.row.id })));
    await db.execute(sql`UPDATE keys SET created_at = '2026-10-01T00:00:00.123456Z'::timestamptz`);
    const first = await (await listKeys(buildJsonRequest("/api/keys?limit=2", { bearer: owner.plaintext }))).json();
    expect(first.next_cursor).toContain(".123456Z~");
    const second = await (await listKeys(buildJsonRequest(`/api/keys?limit=2&cursor=${encodeURIComponent(first.next_cursor)}`, { bearer: owner.plaintext }))).json();
    expect([...first.data, ...second.data].map((key: { id: string }) => key.id)).toEqual([...ids].reverse());
    expect(second.next_cursor).toBeNull();
    const legacy = await listKeys(buildJsonRequest("/api/keys?cursor=2026-10-02T00:00:00.000Z", { bearer: owner.plaintext }));
    expect(legacy.status).toBe(200);
    expect((await legacy.json()).data).toHaveLength(4);
    expect((await listKeys(buildJsonRequest("/api/keys?cursor=garbage", { bearer: owner.plaintext }))).status).toBe(422);
  });
});
