import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHmac, randomUUID } from "node:crypto";

// E2E-12 — Outbound webhook delivery carries a valid HMAC signature derived
// from the destination's signing secret (X-Mantis-Signature = HMAC over
// `${timestamp}.${body}`), and the payload is the expected mantis.hit shape.

import { sendWebhook } from "@/lib/notify/senders";
import type { Hit, Key } from "@/db/schema";
import { startSink, type Sink } from "./_sink";

const SECRET = "test-signing-secret-abcdefghijklmnop";

let sink: Sink | null = null;
beforeEach(() => {
  process.env.ALLOW_PRIVATE_WEBHOOKS = "1"; // allow the loopback sink
});
afterEach(async () => {
  delete process.env.ALLOW_PRIVATE_WEBHOOKS;
  if (sink) {
    await sink.close();
    sink = null;
  }
});

function fakeKey(): Key {
  return {
    id: randomUUID(),
    publicId: "hmackey01",
    kind: "http",
    memo: "hmac canary",
    responseKind: "gif",
    responsePayload: null,
    dedupeWindowSeconds: 60,
    monitorMode: "off",
    monitorWindowSeconds: 300,
    monitorResetAt: null,
    firstDownloadFormat: null,
    createdAt: new Date(),
    disabledAt: null,
    expiresAt: null,
    createdByApiKeyId: null,
  };
}

function fakeHit(keyId: string): Hit {
  return {
    id: randomUUID(),
    keyId,
    occurredAt: new Date(),
    ip: "203.0.113.10",
    userAgent: "curl/8",
    referer: null,
    headers: null,
    uaBrowser: null,
    uaBrowserVersion: null,
    uaOs: null,
    uaDevice: null,
    botLabel: null,
    isDuplicate: false,
  };
}

describe("E2E-12 webhook HMAC signing", () => {
  it("signs the body with the destination secret and sends a mantis.hit payload", async () => {
    sink = await startSink({ status: 200 });
    const key = fakeKey();
    const hit = fakeHit(key.id);

    await sendWebhook({ key, hit, target: sink.url, signingSecret: SECRET });

    expect(sink.requests).toHaveLength(1);
    const req = sink.requests[0]!;

    // Payload shape.
    const body = JSON.parse(req.body) as { type: string; key: { public_id: string } };
    expect(body.type).toBe("mantis.hit");
    expect(body.key.public_id).toBe(key.publicId);

    // Signature verifies against the raw bytes the sink actually received.
    const ts = req.headers["x-mantis-timestamp"];
    expect(ts).toBeTruthy();
    const expected =
      "sha256=" +
      createHmac("sha256", SECRET).update(`${ts}.${req.body}`).digest("hex");
    expect(req.headers["x-mantis-signature"]).toBe(expected);
  });

  it("omits the signature header when no secret is configured", async () => {
    sink = await startSink({ status: 200 });
    const key = fakeKey();
    await sendWebhook({ key, hit: fakeHit(key.id), target: sink.url, signingSecret: null });

    expect(sink.requests).toHaveLength(1);
    expect(sink.requests[0]!.headers["x-mantis-signature"]).toBeUndefined();
  });
});
