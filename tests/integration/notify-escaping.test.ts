import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";

// E2E-13 — Attacker-controlled hit fields (User-Agent, X-Mantis-* host context)
// are escaped in the emitted Slack/Discord/Teams payloads (commit 418d59c7), so
// tripping a canary can't inject mentions or masked markdown links into the
// operator's alert.

import { sendSlack, sendDiscord, sendTeams } from "@/lib/notify/senders";
import type { Hit, Key } from "@/db/schema";
import { startSink, type Sink } from "./_sink";

// Slack mention `<!here>` + markdown link `[x](y)` + host-context link `[u](v)`.
const ATTACK_UA = "INJ<!here>[x](y)INJ";
const ATTACK_USER = "USR[u](v)USR";

let sink: Sink | null = null;
beforeEach(() => {
  process.env.ALLOW_PRIVATE_WEBHOOKS = "1";
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
    publicId: "escapekey1",
    kind: "http",
    memo: "escape canary",
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
    ip: "203.0.113.20",
    userAgent: ATTACK_UA,
    referer: null,
    headers: { "x-mantis-source": "shell", "x-mantis-user": ATTACK_USER },
    uaBrowser: null,
    uaBrowserVersion: null,
    uaOs: null,
    uaDevice: null,
    botLabel: null,
    isDuplicate: false,
  };
}

async function capture(
  send: (ctx: { key: Key; hit: Hit; target: string }) => Promise<void>,
): Promise<string> {
  sink = await startSink({ status: 200 });
  const key = fakeKey();
  await send({ key, hit: fakeHit(key.id), target: sink.url });
  expect(sink.requests).toHaveLength(1);
  return sink.requests[0]!.body;
}

describe("E2E-13 chat-channel payload escaping", () => {
  it("Slack neutralizes <!here> mentions in the UA field", async () => {
    const body = await capture(sendSlack);
    expect(body).not.toContain("<!here>");
    expect(body).toContain("&lt;!here&gt;");
    expect(body).toContain("INJ"); // content preserved, just inert
  });

  it("Discord neutralizes masked markdown links in UA and host context", async () => {
    const body = await capture(sendDiscord);
    expect(body).not.toContain("[x](y)");
    expect(body).not.toContain("[u](v)");
    expect(body).toContain("INJ");
  });

  it("Teams neutralizes masked markdown links in UA and host context", async () => {
    const body = await capture(sendTeams);
    expect(body).not.toContain("[x](y)");
    expect(body).not.toContain("[u](v)");
    expect(body).toContain("INJ");
  });
});
