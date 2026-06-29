import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock safePostJson so we can introspect the URL + payload without making
// a real HTTP call (and to bypass the SSRF preflight against test URLs).
const safePostJson = vi.fn();
vi.mock("@/lib/notify/safe-post", () => ({
  safePostJson: (...args: unknown[]) => safePostJson(...args),
}));

// Mock the drizzle client so fireActivationPing's status-persistence write
// doesn't try to reach a real DB.
vi.mock("@/db/client", () => {
  const chain = {
    set: () => ({ where: async () => undefined }),
  };
  return {
    db: { update: () => chain },
    schema: {},
  };
});

import { sendHomeAssistant } from "@/lib/notify/senders";
import { fireActivationPing } from "@/lib/notify/activation";
import type { Hit, Key, NotificationDestination } from "@/db/schema";

const key: Key = {
  id: "00000000-0000-0000-0000-000000000001",
  publicId: "abc123def456",
  kind: "http",
  memo: "SSH honeypot",
  responseKind: "gif",
  responsePayload: null,
  dedupeWindowSeconds: 60,
  monitorMode: "off",
  monitorWindowSeconds: 300,
  monitorResetAt: null,
  firstDownloadFormat: null,
  createdAt: new Date("2026-05-17T00:00:00Z"),
  disabledAt: null,
  expiresAt: null,
  createdByApiKeyId: null,
};

const hit: Hit = {
  id: "00000000-0000-0000-0000-000000000002",
  keyId: key.id,
  occurredAt: new Date("2026-05-17T12:34:56Z"),
  ip: "203.0.113.42",
  userAgent: "curl/8",
  referer: null,
  headers: {
    "x-mantis-source": "shell",
    "x-mantis-user": "root",
    "x-mantis-host": "prod-bastion",
    "x-mantis-ssh-client": "198.51.100.5 54321 22",
  },
  uaBrowser: null,
  uaBrowserVersion: null,
  uaOs: null,
  uaDevice: null,
  botLabel: null,
  isDuplicate: false,
};

const target = "https://ha.example.com/api/webhook/mantis-abc12345";

beforeEach(() => {
  safePostJson.mockReset();
  safePostJson.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("sendHomeAssistant", () => {
  it("POSTs a flat mantis.hit payload to the webhook URL", async () => {
    await sendHomeAssistant({ key, hit, target });

    expect(safePostJson).toHaveBeenCalledTimes(1);
    const [calledUrl, body, opts] = safePostJson.mock.calls[0]!;
    expect(calledUrl).toBe(target);
    expect(body).toMatchObject({
      type: "mantis.hit",
      memo: "SSH honeypot",
      key_public_id: "abc123def456",
      ip: "203.0.113.42",
      user_agent: "curl/8",
      is_duplicate: false,
      hit_id: hit.id,
      host_context: {
        source: "shell",
        user: "root",
        host: "prod-bastion",
        ssh_client_ip: "198.51.100.5",
      },
    });
    // No HMAC unless the caller explicitly set a signing secret.
    expect(opts).toMatchObject({ signingSecret: null });
  });

  it("passes signingSecret through when set", async () => {
    await sendHomeAssistant({ key, hit, target, signingSecret: "hunter2" });
    const [, , opts] = safePostJson.mock.calls[0]!;
    expect(opts).toMatchObject({ signingSecret: "hunter2" });
  });
});

describe("activation ping for home_assistant", () => {
  it("POSTs a mantis.activation payload and reports ok", async () => {
    const destination: NotificationDestination = {
      id: "00000000-0000-0000-0000-000000000099",
      keyId: key.id,
      channel: "home_assistant",
      target,
      signingSecret: null,
      createdAt: new Date(),
      lastActivationStatus: null,
      lastActivationError: null,
      lastActivationAt: null,
    };

    const result = await fireActivationPing(key, destination);

    expect(result.ok).toBe(true);
    expect(safePostJson).toHaveBeenCalledTimes(1);
    const [calledUrl, body] = safePostJson.mock.calls[0]!;
    expect(calledUrl).toBe(target);
    expect(body).toMatchObject({
      type: "mantis.activation",
      memo: "SSH honeypot",
      activation: true,
      key_public_id: "abc123def456",
    });
  });
});
