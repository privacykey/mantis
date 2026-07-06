import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";

// Enrollment-scoped API keys + idempotent creation via external_id — the
// fleet/MDM provisioning surface. An "enroll" key is meant to be embedded in
// a script pushed to every managed machine, so its blast radius when
// extracted must be: create keys, nothing else. external_id (machine serial)
// makes re-runs of that script return the existing key instead of minting
// duplicates, and a claim must never mutate or expose what IT configured.

vi.mock("@/lib/log", () => ({
  log: { info() {}, warn() {}, error() {}, debug() {}, fatal() {}, trace() {} },
}));

import { POST as createKey, GET as listKeys } from "@/app/api/keys/route";
import {
  GET as getKey,
  PATCH as patchKey,
  DELETE as deleteKey,
} from "@/app/api/keys/[id]/route";
import { GET as recentHits } from "@/app/api/hits/recent/route";
import {
  GET as listApiKeys,
  POST as createApiKey,
} from "@/app/api/api-keys/route";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { auditEvents, keys, notificationDestinations } from "@/db/schema";
import { seedApiKey, buildJsonRequest, ctxParams } from "./_harness";
import { startSink, type Sink } from "./_sink";

let sink: Sink | null = null;

beforeAll(() => {
  // Destination activation pings target the local sink.
  process.env.ALLOW_PRIVATE_WEBHOOKS = "1";
});

afterAll(() => {
  delete process.env.ALLOW_PRIVATE_WEBHOOKS;
});

afterEach(async () => {
  if (sink) {
    await sink.close();
    sink = null;
  }
});

type KeyResponse = Record<string, unknown> & {
  id: string;
  url: string;
  external_id: string | null;
  reused: boolean;
  destinations?: Array<Record<string, unknown>>;
};

async function post(bearer: string, body: unknown) {
  return createKey(
    buildJsonRequest("/api/keys", { method: "POST", bearer, body }),
  );
}

describe("enrollment-scoped API keys", () => {
  it("creates keys and receives the reduced enroll shape (no secrets, no config surface)", async () => {
    sink = await startSink();
    const enroll = await seedApiKey({ scope: "enroll", name: "kandji" });

    const res = await post(enroll.plaintext, {
      memo: "Terminal opened — mac-01 (C02TEST01)",
      external_id: "C02TEST01",
      destinations: [{ channel: "webhook", target: sink.url }],
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as KeyResponse;

    expect(body.reused).toBe(false);
    expect(body.external_id).toBe("C02TEST01");
    expect(typeof body.url).toBe("string");
    expect(body.url).toContain(body.public_id as string);

    // Reduced shape: alert routing/monitoring internals stay hidden.
    expect(body).not.toHaveProperty("monitor_mode");
    expect(body).not.toHaveProperty("dedupe_window_seconds");
    expect(body).not.toHaveProperty("monitor_status_url");

    // The caller supplied this destination, so it may see target + activation
    // status — but never signing material.
    expect(body.destinations).toHaveLength(1);
    const dest = body.destinations![0]!;
    expect(dest.target).toBe(sink.url);
    expect(dest.signing_secret).toBeNull();
    expect(dest.signing_secret_fingerprint).toBeTruthy();

    // Row is real and owned by the enroll key.
    const [row] = await db
      .select()
      .from(keys)
      .where(eq(keys.id, body.id))
      .limit(1);
    expect(row?.createdByApiKeyId).toBe(enroll.row.id);
  });

  it("is locked out of every non-create surface with 403 (valid credential, wrong scope)", async () => {
    const enroll = await seedApiKey({ scope: "enroll" });
    const created = await post(enroll.plaintext, {
      memo: "own canary",
      external_id: "C02TEST02",
    });
    expect(created.status).toBe(201);
    const own = (await created.json()) as KeyResponse;

    const list = await listKeys(
      buildJsonRequest("/api/keys", { bearer: enroll.plaintext }),
    );
    expect(list.status).toBe(403);
    const listBody = (await list.json()) as { error: string };
    expect(listBody.error).toBe("forbidden");
    // 403, not 401 — no WWW-Authenticate challenge for a valid credential.
    expect(list.headers.get("www-authenticate")).toBeNull();

    // Even the key it just created is off-limits for read/mutate/delete.
    const get = await getKey(
      buildJsonRequest(`/api/keys/${own.id}`, { bearer: enroll.plaintext }),
      ctxParams({ id: own.id }),
    );
    expect(get.status).toBe(403);

    const patch = await patchKey(
      buildJsonRequest(`/api/keys/${own.id}`, {
        method: "PATCH",
        bearer: enroll.plaintext,
        body: { disabled: true },
      }),
      ctxParams({ id: own.id }),
    );
    expect(patch.status).toBe(403);

    const del = await deleteKey(
      buildJsonRequest(`/api/keys/${own.id}`, {
        method: "DELETE",
        bearer: enroll.plaintext,
      }),
      ctxParams({ id: own.id }),
    );
    expect(del.status).toBe(403);

    const hits = await recentHits(
      buildJsonRequest("/api/hits/recent", { bearer: enroll.plaintext }),
    );
    expect(hits.status).toBe(403);

    const apiKeysList = await listApiKeys(
      buildJsonRequest("/api/api-keys", { bearer: enroll.plaintext }),
    );
    expect(apiKeysList.status).toBe(403);

    const apiKeysCreate = await createApiKey(
      buildJsonRequest("/api/api-keys", {
        method: "POST",
        bearer: enroll.plaintext,
        body: { name: "sneaky" },
      }),
    );
    expect(apiKeysCreate.status).toBe(403);

    // The blocked mutations really were blocked.
    const [row] = await db
      .select()
      .from(keys)
      .where(eq(keys.id, own.id))
      .limit(1);
    expect(row).toBeDefined();
    expect(row!.disabledAt).toBeNull();
  });

  it("can be minted through POST /api/api-keys and the minted key works for create only", async () => {
    const admin = await seedApiKey({ admin: true });

    const minted = await createApiKey(
      buildJsonRequest("/api/api-keys", {
        method: "POST",
        bearer: admin.plaintext,
        body: { name: "fleet-enroll", scope: "enroll" },
      }),
    );
    expect(minted.status).toBe(201);
    const mintedBody = (await minted.json()) as {
      scope: string;
      key: string;
      is_admin: boolean;
    };
    expect(mintedBody.scope).toBe("enroll");
    expect(mintedBody.is_admin).toBe(false);

    const create = await post(mintedBody.key, {
      memo: "minted-enroll canary",
      external_id: "C02TEST03",
    });
    expect(create.status).toBe(201);

    const list = await listKeys(
      buildJsonRequest("/api/keys", { bearer: mintedBody.key }),
    );
    expect(list.status).toBe(403);

    // enroll + admin is a contradiction and must not validate.
    const contradiction = await createApiKey(
      buildJsonRequest("/api/api-keys", {
        method: "POST",
        bearer: admin.plaintext,
        body: { name: "impossible", scope: "enroll", is_admin: true },
      }),
    );
    expect(contradiction.status).toBe(422);
  });
});

describe("idempotent enrollment via external_id", () => {
  it("re-posting the same external_id returns the existing key untouched", async () => {
    sink = await startSink();
    const owner = await seedApiKey({ name: "provisioner" });

    const first = await post(owner.plaintext, {
      memo: "Terminal — mac-42 (SERIAL42)",
      external_id: "SERIAL42",
      destinations: [{ channel: "webhook", target: sink.url }],
    });
    expect(first.status).toBe(201);
    const created = (await first.json()) as KeyResponse;
    expect(created.reused).toBe(false);
    expect(created.external_id).toBe("SERIAL42");

    // Re-run with a different memo and destination — a claim must not apply
    // either.
    const second = await post(owner.plaintext, {
      memo: "some other memo",
      external_id: "SERIAL42",
      destinations: [
        { channel: "webhook", target: `${sink.url}somewhere-else` },
      ],
    });
    expect(second.status).toBe(200);
    const claimed = (await second.json()) as KeyResponse;
    expect(claimed.reused).toBe(true);
    expect(claimed.id).toBe(created.id);
    expect(claimed.memo).toBe("Terminal — mac-42 (SERIAL42)");

    // Owner gets the full shape on claim, but with no secret reveal.
    expect(claimed).toHaveProperty("monitor_mode");
    expect(claimed.destinations).toHaveLength(1);
    expect(claimed.destinations![0]!.target).toBe(sink.url);
    expect(claimed.destinations![0]!.signing_secret ?? null).toBeNull();

    // DB agrees: one key, one original destination.
    const rows = await db
      .select()
      .from(keys)
      .where(eq(keys.externalId, "SERIAL42"));
    expect(rows).toHaveLength(1);
    const dests = await db
      .select()
      .from(notificationDestinations)
      .where(eq(notificationDestinations.keyId, created.id));
    expect(dests).toHaveLength(1);
    expect(dests[0]!.target).toBe(sink.url);

    // The claim left an audit trail.
    const claimsAudit = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.eventType, "key.claimed"));
    expect(claimsAudit).toHaveLength(1);
    expect(claimsAudit[0]!.subjectId).toBe(created.id);
  });

  it("claims by non-owners return the reduced shape; admins get the full shape", async () => {
    sink = await startSink();
    const owner = await seedApiKey({ name: "provisioner" });
    const stranger = await seedApiKey({ name: "other-full-key" });
    const enroll = await seedApiKey({ scope: "enroll" });
    const admin = await seedApiKey({ admin: true });

    const first = await post(owner.plaintext, {
      memo: "Terminal — mac-7 (SERIAL7)",
      external_id: "SERIAL7",
      destinations: [{ channel: "webhook", target: sink.url }],
    });
    expect(first.status).toBe(201);
    const created = (await first.json()) as KeyResponse;

    // A shared enroll credential can recover the trigger URL (reimage case)…
    const enrollClaim = await post(enroll.plaintext, {
      memo: "ignored",
      external_id: "SERIAL7",
    });
    expect(enrollClaim.status).toBe(200);
    const enrollBody = (await enrollClaim.json()) as KeyResponse;
    expect(enrollBody.id).toBe(created.id);
    expect(enrollBody.reused).toBe(true);
    expect(enrollBody.url).toBe(created.url);
    // …but nothing about alert routing leaks to it.
    expect(enrollBody).not.toHaveProperty("destinations");
    expect(enrollBody).not.toHaveProperty("monitor_mode");

    // An unrelated full key is treated the same as the enroll key.
    const strangerClaim = await post(stranger.plaintext, {
      memo: "ignored",
      external_id: "SERIAL7",
    });
    expect(strangerClaim.status).toBe(200);
    const strangerBody = (await strangerClaim.json()) as KeyResponse;
    expect(strangerBody.id).toBe(created.id);
    expect(strangerBody).not.toHaveProperty("destinations");

    // Admin claim sees the whole thing (it could GET the key anyway).
    const adminClaim = await post(admin.plaintext, {
      memo: "ignored",
      external_id: "SERIAL7",
    });
    expect(adminClaim.status).toBe(200);
    const adminBody = (await adminClaim.json()) as KeyResponse;
    expect(adminBody.id).toBe(created.id);
    expect(adminBody.destinations).toHaveLength(1);
    expect(adminBody.destinations![0]!.target).toBe(sink.url);
  });

  it("distinct external_ids mint distinct keys; malformed ones are rejected", async () => {
    const enroll = await seedApiKey({ scope: "enroll" });

    const a = await post(enroll.plaintext, {
      memo: "mac-a",
      external_id: "SERIAL-A",
    });
    const b = await post(enroll.plaintext, {
      memo: "mac-b",
      external_id: "SERIAL-B",
    });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    const aBody = (await a.json()) as KeyResponse;
    const bBody = (await b.json()) as KeyResponse;
    expect(aBody.id).not.toBe(bBody.id);

    for (const bad of ["has spaces", "-leading-dash", "semi;colon", ""]) {
      const res = await post(enroll.plaintext, {
        memo: "bad",
        external_id: bad,
      });
      expect(res.status).toBe(422);
    }
  });
});
