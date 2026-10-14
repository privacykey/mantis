import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Reading an alert must not fire the canary. Every formatter used to embed the
// live TRIGGER URL as its link (Teams even labelled it "Open key in
// dashboard"), so an operator following the alert became a new hit: another
// alert, a moved dedupe window, a re-tripped monitor.
//
// This renders every channel's alert and activation message for a real key,
// follows every URL a person would be shown — through the real trigger route —
// and asserts nothing was recorded. The control follows the one field that is
// documented as firing (the webhook's key.url) and shows the harness can tell.

const mail = vi.hoisted(() => {
  process.env.SMTP_URL = "smtp://127.0.0.1:2525";
  return { sendMail: vi.fn() };
});
vi.mock("nodemailer", () => ({
  default: { createTransport: () => ({ sendMail: mail.sendMail }) },
}));
vi.mock("@/lib/log", () => ({
  log: { info() {}, warn() {}, error() {}, debug() {}, fatal() {}, trace() {} },
}));

import { NextRequest } from "next/server";
import { db } from "@/db/client";
import {
  hits,
  notificationDestinations,
  notifications,
  type Hit,
  type Key,
  type NotificationChannel,
} from "@/db/schema";
import { GET as trigger } from "@/app/c/[publicId]/route";
import { env, keyDashboardUrl, keyUrl } from "@/lib/env";
import { fireActivationPing } from "@/lib/notify/activation";
import { send } from "@/lib/notify/senders";
import { ctxParams, seedApiKey, seedCanaryKey } from "./_harness";
import { startSink, type Sink } from "./_sink";

const CHANNELS: NotificationChannel[] = ["slack", "discord", "teams", "email", "webhook", "home_assistant"];
const HUMAN = new Set<NotificationChannel>(["slack", "discord", "teams", "email"]);

let sink: Sink | null = null;
beforeEach(() => {
  process.env.ALLOW_PRIVATE_WEBHOOKS = "1"; // allow the loopback sink
  mail.sendMail.mockReset().mockResolvedValue(undefined);
});
afterEach(async () => {
  delete process.env.ALLOW_PRIVATE_WEBHOOKS;
  if (sink) {
    await sink.close();
    sink = null;
  }
});

/** A dedupe-off key (every recorded request is a primary hit) with a global destination. */
async function seedKeyWithOneHit(): Promise<{ key: Key; hit: Hit }> {
  const owner = await seedApiKey();
  const key = await seedCanaryKey(owner.row.id, { dedupeWindowSeconds: 0, memo: "prod .env canary" });
  await db
    .insert(notificationDestinations)
    .values({ keyId: null, channel: "webhook", target: "https://soc.example/hook" });
  const [hit] = await db
    .insert(hits)
    .values({ keyId: key.id, ip: "203.0.113.7", userAgent: "curl/8", referer: "https://clone.attacker.test/" })
    .returning();
  return { key, hit: hit! };
}

/** Delivers one alert and one activation per channel; returns what each channel received. */
async function renderAll(key: Key, hit: Hit): Promise<Array<{ channel: NotificationChannel; kind: string; message: unknown }>> {
  const out: Array<{ channel: NotificationChannel; kind: string; message: unknown }> = [];
  for (const channel of CHANNELS) {
    const target = channel === "email" ? "ops@example.test" : sink!.url;
    const taken = () =>
      channel === "email"
        ? mail.sendMail.mock.calls.at(-1)![0]
        : JSON.parse(sink!.requests.at(-1)!.body);

    await send(channel, { key, hit, target });
    out.push({ channel, kind: "alert", message: taken() });

    const result = await fireActivationPing(key, {
      id: crypto.randomUUID(),
      keyId: key.id,
      channel,
      target,
      signingSecret: null,
      createdAt: new Date(),
      lastActivationStatus: null,
      lastActivationError: null,
      lastActivationAt: null,
    });
    expect(result).toEqual({ ok: true });
    out.push({ channel, kind: "activation", message: taken() });
  }
  return out;
}

/** Every http(s) URL anywhere in a message. */
function urlsIn(message: unknown): string[] {
  return JSON.stringify(message).match(/https?:\/\/[^\s"'<>|)\\]+/g) ?? [];
}

/** What a browser does with a URL on this instance: a GET that reaches the trigger route, or not. */
async function follow(url: string): Promise<void> {
  const u = new URL(url);
  if (u.origin !== new URL(env.publicBaseUrl).origin) return;
  const m = new RegExp(`^${env.publicPath}/([^/]+)$`).exec(u.pathname);
  if (!m) return;
  await trigger(new NextRequest(u, { headers: { "user-agent": "Mozilla/5.0 operator" } }), ctxParams({ publicId: m[1]! }));
}

async function counts() {
  return {
    hits: (await db.select().from(hits)).length,
    notifications: (await db.select().from(notifications)).length,
  };
}

describe("following an alert does not fire the canary", () => {
  it("no human-facing alert or activation message contains the trigger URL", async () => {
    sink = await startSink({ status: 200 });
    const { key, hit } = await seedKeyWithOneHit();
    const rendered = (await renderAll(key, hit)).filter((r) => HUMAN.has(r.channel));
    expect(rendered).toHaveLength(8);

    for (const { channel, kind, message } of rendered) {
      const label = `${channel} ${kind}`;
      expect(JSON.stringify(message), label).not.toContain(keyUrl(key.publicId));
      expect(urlsIn(message), label).toContain(keyDashboardUrl(key.id));
    }
  });

  it("following every URL a person is shown records no hit and queues no alert", async () => {
    sink = await startSink({ status: 200 });
    const { key, hit } = await seedKeyWithOneHit();
    const rendered = await renderAll(key, hit);
    const before = await counts();
    expect(before).toEqual({ hits: 1, notifications: 0 });

    const shown = rendered.flatMap(({ channel, message }) => {
      if (HUMAN.has(channel)) return urlsIn(message);
      // Machine payloads: the link meant for people is dashboard_url.
      const payload = message as { dashboard_url?: string; key?: { dashboard_url?: string } | null };
      return [payload.dashboard_url ?? payload.key?.dashboard_url ?? ""].filter(Boolean);
    });
    expect(shown.length).toBeGreaterThanOrEqual(12);
    for (const url of shown) await follow(url);

    expect(await counts()).toEqual(before);
  });

  it("control: the webhook's key.url is the trigger, and following it does fire", async () => {
    sink = await startSink({ status: 200 });
    const { key, hit } = await seedKeyWithOneHit();
    const rendered = await renderAll(key, hit);
    const webhookAlert = rendered.find((r) => r.channel === "webhook" && r.kind === "alert")!
      .message as { key: { url: string; dashboard_url: string } };
    expect(webhookAlert.key.url).toBe(keyUrl(key.publicId));
    expect(webhookAlert.key.dashboard_url).toBe(keyDashboardUrl(key.id));

    await follow(webhookAlert.key.url);

    // Dedupe is off, so the follower became a primary hit with its own alert.
    expect(await counts()).toEqual({ hits: 2, notifications: 1 });
  });
});
