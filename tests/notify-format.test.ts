import { beforeEach, describe, expect, it, vi } from "vitest";

// What every channel actually sends, with the transports stubbed:
//  - no human-facing alert or activation message links or prints the TRIGGER
//    URL (following it fires the canary); they link the dashboard key page;
//  - the machine payloads keep the trigger URL only in key.url / key_url and
//    carry dashboard_url next to it;
//  - the hit's Referer is shown on every chat channel and Home Assistant;
//  - no anonymous-controlled value can push a chat field past the platform's
//    limit, where the platform would reject the whole alert.

const transport = vi.hoisted(() => {
  process.env.SMTP_URL = "smtp://127.0.0.1:2525";
  process.env.DASHBOARD_BASE_URL = "https://dash.example.test";
  return { safePostJson: vi.fn(), sendMail: vi.fn() };
});

vi.mock("@/lib/notify/safe-post", () => ({
  safePostJson: (...args: unknown[]) => transport.safePostJson(...args),
}));
vi.mock("nodemailer", () => ({
  default: { createTransport: () => ({ sendMail: transport.sendMail }) },
}));
vi.mock("@/lib/log", () => ({ log: { info() {}, warn() {}, error() {}, debug() {} } }));
// fireActivationPing persists the outcome on the destination row.
vi.mock("@/db/client", () => ({
  db: { update: () => ({ set: () => ({ where: async () => undefined }) }) },
}));

import type { Hit, Key, NotificationChannel, NotificationDestination } from "@/db/schema";
import { keyDashboardUrl, keyUrl } from "@/lib/env";
import { fireActivationPing } from "@/lib/notify/activation";
import { send } from "@/lib/notify/senders";

const key: Key = {
  id: "00000000-0000-4000-8000-000000000001",
  publicId: "AbCdEf1234",
  kind: "http",
  memo: "prod .env canary",
  externalId: null,
  responseKind: "gif",
  responsePayload: null,
  dedupeWindowSeconds: 0,
  monitorMode: "off",
  monitorWindowSeconds: 300,
  monitorResetAt: null,
  firstDownloadFormat: null,
  selfOrigins: [],
  createdAt: new Date("2026-10-01T00:00:00Z"),
  disabledAt: null,
  expiresAt: null,
  createdByApiKeyId: null,
};

function hit(overrides: Partial<Hit> = {}): Hit {
  return {
    id: "00000000-0000-4000-8000-000000000002",
    keyId: key.id,
    occurredAt: new Date("2026-10-01T12:34:56Z"),
    ip: "203.0.113.42",
    userAgent: "curl/8",
    referer: "https://clone.attacker.test/login",
    headers: { "x-mantis-source": "shell", "x-mantis-user": "root", "x-mantis-host": "bastion" },
    uaBrowser: null,
    uaBrowserVersion: null,
    uaOs: null,
    uaDevice: null,
    botLabel: null,
    isDuplicate: false,
    ...overrides,
  };
}

function destination(channel: NotificationChannel): NotificationDestination {
  return {
    id: "00000000-0000-4000-8000-000000000099",
    keyId: key.id,
    channel,
    target: channel === "email" ? "ops@example.test" : "https://receiver.example.test/hook",
    signingSecret: null,
    createdAt: new Date(),
    lastActivationStatus: null,
    lastActivationError: null,
    lastActivationAt: null,
  };
}

const TRIGGER = keyUrl(key.publicId);
const DASHBOARD = keyDashboardUrl(key.id);
const HUMAN: NotificationChannel[] = ["slack", "discord", "teams", "email"];
const MACHINE: NotificationChannel[] = ["webhook", "home_assistant"];

/** Every http(s) URL anywhere in a delivered message. */
function urlsIn(message: unknown): string[] {
  return JSON.stringify(message).match(/https?:\/\/[^\s"'<>|)\\]+/g) ?? [];
}

/** The message a channel delivered: the JSON body, or the mail. */
function delivered(channel: NotificationChannel): unknown {
  if (channel === "email") {
    expect(transport.sendMail).toHaveBeenCalledTimes(1);
    return transport.sendMail.mock.calls[0]![0];
  }
  expect(transport.safePostJson).toHaveBeenCalledTimes(1);
  return transport.safePostJson.mock.calls[0]![1];
}

async function alert(channel: NotificationChannel, h: Hit = hit(), k: Key = key): Promise<unknown> {
  await send(channel, { key: k, hit: h, target: destination(channel).target });
  return delivered(channel);
}

async function activation(channel: NotificationChannel, k: Key | null = key): Promise<unknown> {
  const result = await fireActivationPing(k, { ...destination(channel), keyId: k?.id ?? null });
  expect(result).toEqual({ ok: true });
  return delivered(channel);
}

beforeEach(() => {
  transport.safePostJson.mockReset().mockResolvedValue(undefined);
  transport.sendMail.mockReset().mockResolvedValue(undefined);
});

describe("alert and activation links never fire the canary", () => {
  it("uses a dashboard origin distinct from the trigger origin in this suite", () => {
    expect(DASHBOARD).toBe(`https://dash.example.test/keys/${key.id}`);
    expect(TRIGGER).toBe(`http://localhost:3000/c/${key.publicId}`);
  });

  it.each(HUMAN)("%s alert links the dashboard key page, not the trigger URL", async (channel) => {
    const urls = urlsIn(await alert(channel));
    expect(urls).toContain(DASHBOARD);
    expect(urls.filter((u) => u.includes(key.publicId))).toEqual([]);
    expect(JSON.stringify(delivered(channel))).not.toContain(TRIGGER);
  });

  it.each(HUMAN)("%s activation links the dashboard key page, not the trigger URL", async (channel) => {
    const urls = urlsIn(await activation(channel));
    expect(urls).toContain(DASHBOARD);
    expect(JSON.stringify(delivered(channel))).not.toContain(TRIGGER);
  });

  it.each(HUMAN)("%s global activation links the dashboard root", async (channel) => {
    const message = await activation(channel, null);
    expect(urlsIn(message)).toContain("https://dash.example.test");
    expect(JSON.stringify(message)).not.toContain("localhost:3000");
  });

  it("Teams labels its link as the dashboard and points it there", async () => {
    expect(JSON.stringify(await alert("teams"))).toContain(`[Open key in dashboard](${DASHBOARD})`);
    transport.safePostJson.mockClear();
    expect(JSON.stringify(await activation("teams"))).toContain(`[Open in dashboard](${DASHBOARD})`);
  });

  it("webhook payloads carry the trigger URL only as key.url, next to key.dashboard_url", async () => {
    const hitPayload = (await alert("webhook")) as { key: Record<string, unknown> };
    expect(hitPayload.key.url).toBe(TRIGGER);
    expect(hitPayload.key.dashboard_url).toBe(DASHBOARD);
    expect(urlsIn({ ...hitPayload, key: { ...hitPayload.key, url: null } })).not.toContain(TRIGGER);

    transport.safePostJson.mockClear();
    const activationPayload = (await activation("webhook")) as { key: Record<string, unknown> };
    expect(activationPayload.key.url).toBe(TRIGGER);
    expect(activationPayload.key.dashboard_url).toBe(DASHBOARD);
    expect(
      urlsIn({ ...activationPayload, key: { ...activationPayload.key, url: null } }),
    ).not.toContain(TRIGGER);
  });

  it("Home Assistant payloads carry the trigger URL only as key_url, next to dashboard_url", async () => {
    const hitPayload = (await alert("home_assistant")) as Record<string, unknown>;
    expect(hitPayload.key_url).toBe(TRIGGER);
    expect(hitPayload.dashboard_url).toBe(DASHBOARD);
    expect(urlsIn({ ...hitPayload, key_url: null })).not.toContain(TRIGGER);

    transport.safePostJson.mockClear();
    const activationPayload = (await activation("home_assistant")) as Record<string, unknown>;
    expect(activationPayload.key_url).toBe(TRIGGER);
    expect(activationPayload.dashboard_url).toBe(DASHBOARD);
    expect(urlsIn({ ...activationPayload, key_url: null })).not.toContain(TRIGGER);
  });

  it.each(MACHINE)("%s global activation has no trigger URL to give", async (channel) => {
    const payload = (await activation(channel, null)) as Record<string, unknown>;
    expect(JSON.stringify(payload)).not.toContain("localhost:3000");
    if (channel === "webhook") expect(payload.key).toBeNull();
    else expect(payload).toMatchObject({ key_url: null, dashboard_url: "https://dash.example.test" });
  });
});

describe("the hit's Referer reaches every chat channel and Home Assistant", () => {
  // Anonymous-controlled: a mention and a masked link that must arrive inert.
  const REFERER = "https://clone.attacker.test/<!here>[x](https://evil.example)";

  it("Slack shows it, escaped", async () => {
    const body = JSON.stringify(await alert("slack", hit({ referer: REFERER })));
    expect(body).toContain("*Referer*");
    expect(body).toContain("clone.attacker.test");
    expect(body).not.toContain("<!here>");
  });

  it.each(["discord", "teams"] as const)("%s shows it, escaped", async (channel) => {
    const body = JSON.stringify(await alert(channel, hit({ referer: REFERER })));
    expect(body).toContain("Referer");
    expect(body).toContain("clone.attacker.test");
    expect(body).not.toContain("[x](https://evil.example)");
  });

  it("Home Assistant carries it as data", async () => {
    expect(await alert("home_assistant", hit({ referer: REFERER }))).toMatchObject({
      referer: REFERER,
    });
  });

  it("Slack keeps it inside the 10-field cap, ahead of the optional host context", async () => {
    const message = (await alert("slack")) as { blocks: Array<{ fields?: Array<{ text: string }> }> };
    const labels = message.blocks.at(-1)!.fields!.map((f) => f.text.split("\n")[0]);
    expect(labels.slice(0, 3)).toEqual(["*IP*", "*UA*", "*Referer*"]);
  });

  it("is omitted when the hit has none", async () => {
    expect(JSON.stringify(await alert("slack", hit({ referer: null })))).not.toContain("Referer");
  });
});

describe("oversized anonymous values cannot make a platform reject the alert", () => {
  // Each value is at the size Node accepts in one header, and made of the
  // characters that grow most under each platform's escaping.
  const huge = (unit: string) => unit.repeat(Math.ceil(8000 / unit.length));
  const hostile = (unit: string): Hit =>
    hit({
      ip: huge(unit),
      userAgent: huge(unit),
      referer: huge(unit),
      headers: {
        "x-mantis-user": huge(unit),
        "x-mantis-host": huge(unit),
        "x-mantis-ssh-client": `${huge(unit)} 54321 22`,
        "x-mantis-sudo-cmd": huge(unit),
      },
    });
  const longMemo: Key = { ...key, memo: "m".repeat(500) };

  it.each(["&", "<", "a"])("Slack fields stay within 2000 characters (%j)", async (unit) => {
    const message = (await alert("slack", hostile(unit), longMemo)) as {
      blocks: Array<{ type: string; text?: { text: string }; fields?: Array<{ text: string }> }>;
    };
    const fields = message.blocks.at(-1)!.fields!;
    expect(fields).toHaveLength(7);
    expect(fields.length).toBeLessThanOrEqual(10);
    for (const field of fields) expect(field.text.length).toBeLessThanOrEqual(2000);
    // Never half an entity.
    for (const field of fields) expect(field.text).not.toMatch(/&(?!amp;|lt;|gt;)/);
    // The header block has its own, much smaller limit.
    expect(message.blocks[0]!.text!.text.length).toBeLessThanOrEqual(150);
  });

  it.each(["_", "\\", "a"])("Discord stays within its field and embed limits (%j)", async (unit) => {
    const message = (await alert("discord", hostile(unit), longMemo)) as {
      embeds: Array<{ title: string; fields: Array<{ name: string; value: string }> }>;
    };
    const embed = message.embeds[0]!;
    expect(embed.title.length).toBeLessThanOrEqual(256);
    expect(embed.fields.length).toBeLessThanOrEqual(25);
    for (const field of embed.fields) {
      expect(field.name.length).toBeLessThanOrEqual(256);
      expect(field.value.length).toBeLessThanOrEqual(1024);
    }
    const total =
      embed.title.length +
      embed.fields.reduce((sum, f) => sum + f.name.length + f.value.length, 0);
    expect(total).toBeLessThanOrEqual(6000);
  });

  it.each(["_", "a"])("Teams facts stay modest (%j)", async (unit) => {
    const message = (await alert("teams", hostile(unit))) as {
      attachments: Array<{ content: { body: Array<{ facts?: Array<{ value: string }> }> } }>;
    };
    const facts = message.attachments[0]!.content.body.at(-1)!.facts!;
    for (const fact of facts) expect(fact.value.length).toBeLessThanOrEqual(256);
    expect(JSON.stringify(message).length).toBeLessThan(8000);
  });

  it("Discord activation title stays within 256 characters", async () => {
    const message = (await activation("discord", longMemo)) as { embeds: Array<{ title: string }> };
    expect(message.embeds[0]!.title.length).toBeLessThanOrEqual(256);
  });
});
