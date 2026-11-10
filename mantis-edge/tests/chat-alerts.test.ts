import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { forward } from "../src/forward";
import type { Channel } from "../src/types";

// What the chat formatters put on the wire: no live trigger link, and no
// value long enough for the destination to reject the alert.

const HOST = "mantis-edge.example.workers.dev";
// Shape of a real sealed blob: version + nonce + ciphertext + tag, base64url.
const BLOB = `AQx1Yz-aB3${"x1Y_z-".repeat(20)}Q9`;
const TRIGGER_URL = `https://${HOST}/c/${BLOB}`;
const CHAT_CHANNELS = ["slack", "discord", "teams"] as const;

let sent: string | null = null;

beforeEach(() => {
  sent = null;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      sent = String(init.body);
      return new Response(null, { status: 200 });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function fire(
  channel: Channel,
  headers: Record<string, string> = {},
  memo?: string,
  url = TRIGGER_URL,
): Promise<string> {
  await forward(
    { w: "https://hooks.example.com/inbox", c: channel, m: memo },
    new Request(url, { headers }),
  );
  expect(sent).not.toBeNull();
  return sent!;
}

function readable(text: string | undefined): string | undefined {
  return text?.replace(/\u2060/g, "").replace(/\u00a0/g, " ");
}

type SlackText = {
  type: string;
  text: string;
  timestamp?: number;
  format?: string;
  fallback?: string;
  style?: { bold?: boolean; code?: boolean };
};

type SlackBlock = {
  type: string;
  text?: SlackText;
  fields?: SlackText[];
  elements?: Array<SlackText & { elements?: SlackText[] }>;
};

type SlackBody = {
  attachments: Array<{ color: string; blocks: SlackBlock[]; fallback: string }>;
};
type DiscordBody = {
  embeds: Array<{
    title: string;
    description: string;
    fields?: Array<{ name: string; value: string; inline: boolean }>;
    url?: string;
    footer?: { text: string };
  }>;
};
type TeamsBody = {
  attachments: Array<{
    content: {
      backgroundImage?: { url: string; fillMode: string };
      body: Array<{
        type: string;
        text?: string;
        fontType?: string;
        wrap?: boolean;
        items?: Array<{ type: string; text?: string; fontType?: string; wrap?: boolean }>;
        inlines?: Array<{ type: string; text: string; fontType?: string }>;
      }>;
    };
  }>;
};

function slackSpans(body: SlackBody): SlackText[] {
  return body.attachments[0]!.blocks.flatMap((block) =>
    block.elements?.flatMap((section) => section.elements ?? []) ?? [],
  );
}

describe("edge chat alerts never link the live trigger", () => {
  it.each(CHAT_CHANNELS)("%s keeps a URL-shaped source address in literal code", async (channel) => {
    const address = "https://example.invalid/source";
    const raw = await fire(channel, { "cf-connecting-ip": address });
    if (channel === "slack") {
      expect(slackSpans(JSON.parse(raw) as SlackBody)).toContainEqual({ type: "text", text: address, style: { code: true } });
    } else if (channel === "discord") {
      expect((JSON.parse(raw) as DiscordBody).embeds[0]!.description).toContain(`\`${address}\``);
    } else {
      expect((JSON.parse(raw) as TeamsBody).attachments[0]!.content.body).toContainEqual(expect.objectContaining({ text: address, fontType: "Monospace" }));
    }
  });

  it("uses the event time for native relative dates while retaining exact UTC time", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-10T07:42:16.000Z"));
    const seconds = Date.now() / 1000;
    const slack = JSON.parse(await fire("slack")) as SlackBody;
    const date = slackSpans(slack).find((part) => part.type === "date");
    expect(date).toMatchObject({ timestamp: seconds, format: "{ago}", fallback: "2026-11-10 07:42:16 UTC" });
    expect(date).not.toHaveProperty("url");
    expect(slack.attachments[0]!.fallback).toContain("2026-11-10 07:42:16 UTC");
    const discord = JSON.parse(await fire("discord")) as DiscordBody;
    expect(discord.embeds[0]!.description).toContain(`<t:${seconds}:R>`);
    expect(discord.embeds[0]!.description).toContain("10 Nov 07:42:16 UTC".replace(/ /g, "\u00a0"));
    const teams = JSON.parse(await fire("teams")) as TeamsBody;
    expect(teams.attachments[0]!.content.body.flatMap((block) => block.inlines ?? [block])).toContainEqual(expect.objectContaining({ text: "\u00a0· " + "10 Nov 07:42:16 UTC".replace(/ /g, "\u00a0") }));
  });

  it.each(CHAT_CHANNELS)("%s shows an inert fragment, not the URL", async (channel) => {
    const raw = await fire(channel, {}, "prod bastion", `${TRIGGER_URL}?utm=x#frag`);

    // The sealed blob — the part that makes the URL fire — is not in the alert.
    expect(raw).not.toContain(BLOB);
    expect(raw).not.toContain(BLOB.slice(0, 20));
    expect(raw).not.toContain("/c/");
    // No absolute URL to the worker and no link syntax around anything.
    expect(raw).not.toContain(`//${HOST}`);
    expect(raw).not.toMatch(/<https?:[^>]*>/); // Slack <url|label>
    expect(raw).not.toMatch(/\]\(/); // markdown [label](url)
    // What is shown instead: short fragments from both ends and the host.
    expect(readable(raw)).toContain(`${BLOB.slice(0, 6)}…${BLOB.slice(-4)}`);
    expect(raw).toContain(HOST);
  });

  it("slack accents the complete alert and separates the metadata lines", async () => {
    const body = JSON.parse(await fire("slack", {}, "prod bastion")) as SlackBody;
    const attachment = body.attachments[0]!;
    expect(attachment.color).toBe("#ef4444");
    expect(attachment.blocks[0]!.type).toBe("header");
    expect(attachment.fallback).toContain("Mantis Edge\nprod bastion\n🔴 tripped");
    expect(readable(attachment.blocks.at(-1)!.elements?.[0]?.text)).toMatch(
      /Mantis Edge, mantis-edge\.example\.workers\.dev, ref AQx1Yz…z-Q9$/,
    );
  });

  it("discord has no title link", async () => {
    const body = JSON.parse(await fire("discord", {}, "prod bastion")) as DiscordBody;
    expect(body.embeds[0]).not.toHaveProperty("url");
    expect(body.embeds[0]!.description).not.toContain("AQx1Yz…z-Q9");
    expect(readable(body.embeds[0]!.footer?.text)).toMatch(/Mantis Edge, mantis-edge\.example\.workers\.dev, ref AQx1Yz…z-Q9$/);
  });

  it("teams shows plain text in place of the markdown link", async () => {
    const body = JSON.parse(await fire("teams", {}, "prod bastion")) as TeamsBody;
    const { content } = body.attachments[0]!;
    expect(readable(content.body.at(-1)!.text)).toContain("ref AQx1Yz…z-Q9");
    expect(content.backgroundImage).toEqual({ url: expect.stringMatching(/^data:image\/png;base64,/), fillMode: "repeatVertically" });
    // Markdown escapes preserve underscores in a literal reference.
    const other = JSON.parse(
      await fire("teams", {}, undefined, `https://${HOST}/c/A_b_c_d${"E".repeat(60)}`),
    ) as TeamsBody;
    expect(readable(other.attachments[0]!.content.body.at(-1)!.text)).toContain(
      "ref A\\_b\\_c\\_…EEEE",
    );
  });

  it("the raw webhook payload still carries the URL as machine data", async () => {
    const body = JSON.parse(await fire("webhook")) as { key: { url: string } };
    expect(body.key.url).toBe(TRIGGER_URL);
  });

  it.each(CHAT_CHANNELS)("%s explains a request with no source details", async (channel) => {
    const raw = await fire(channel, {}, " \t ");
    expect(raw).toContain("Unnamed canary");
    expect(readable(raw)).toContain("AQx1Yz…z-Q9");
    expect(raw).toContain("No source details reported.");
    expect(raw).toContain("tripped");
    expect(raw).toMatch(/\d{1,2}\s[A-Z][a-z]{2}\s\d\d:\d\d:\d\d\sUTC/);
    expect(raw).toMatch(/\d\d:\d\d:\d\d\sUTC/);
    expect(raw).not.toContain("observed IP");
    expect(raw).not.toContain("Agent:");
  });

  it("renders a Teams command even when it is the only source detail", async () => {
    const raw = await fire("teams", { "x-mantis-sudo-cmd": "systemctl status sshd" });
    const body = (JSON.parse(raw) as TeamsBody).attachments[0]!.content.body;
    expect(body.flatMap((block) => block.items ?? block.inlines ?? [block])).toContainEqual(expect.objectContaining({
      text: "$ sudo systemctl status sshd",
      wrap: true,
    }));
    expect(raw).toContain("No actor, SSH client or request IP available.");
  });

  it("retains the executable and final argument of a long command", async () => {
    const raw = await fire("discord", { "x-mantis-sudo-cmd": `systemctl ${"enable ".repeat(80)}last.service` });
    const { description } = (JSON.parse(raw) as DiscordBody).embeds[0]!;
    const value = description.split("\n").find((line) => line.startsWith("`sudo "))!.replace(/[`*]/g, "").replace(/^sudo /, "");
    expect(value).toMatch(/^systemctl .*….*last\.service$/);
    expect(value.length).toBeLessThanOrEqual(80);
  });

  it("keeps the agent/version and the end of a long user agent in the footer", async () => {
    const raw = await fire("discord", { "user-agent": `curl/8.7.1 ${"a".repeat(120)} diagnostic-tail` });
    const { footer } = (JSON.parse(raw) as DiscordBody).embeds[0]!;
    expect(footer?.text.split("\n").find((line) => line.startsWith("agent: "))).toMatch(/^agent: “curl\/8\.7\.1 .*…\u2060.*diagnostic-tail”$/);
  });

  it("uses wrapping Teams text for long hostnames and IPv6 addresses", async () => {
    const host = `bastion-${"a".repeat(60)}.example.invalid`;
    const address = "2001:db8:1234:5678:abcd:ef00:1234:5678";
    const raw = await fire("teams", {
      "x-mantis-host": host,
      "cf-connecting-ip": address,
      "x-mantis-ssh-client": "198.51.100.7 50022 22",
    });
    const { body } = (JSON.parse(raw) as TeamsBody).attachments[0]!.content;
    expect(body).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "TextBlock", wrap: true, text: `Host: ${host}` }),
      expect.objectContaining({ type: "TextBlock", text: "observed IP:", wrap: true }),
      expect.objectContaining({ type: "TextBlock", text: address, wrap: true }),
    ]));
    expect(body.some((block) => block.type === "ColumnSet")).toBe(false);
  });

  it("keeps the identifying hostname before a shared domain when shortening an actor", async () => {
    const body = JSON.parse(await fire("slack", {
      "x-mantis-user": "deploy",
      "x-mantis-host": "bastion-east-01.production.example.invalid",
    })) as SlackBody;
    expect(slackSpans(body)).toContainEqual({
      type: "text", text: expect.stringMatching(/^deploy@basti.*….*01.*example\.invalid$/), style: { bold: true },
    });
  });

  it("retains a device-only report when the device matches the memo", async () => {
    const body = JSON.parse(await fire("slack", { "x-mantis-device": "Garage camera" }, "Garage camera")) as SlackBody;
    expect(body.attachments[0]!.fallback).toContain("Device: Garage camera");
    expect(body.attachments[0]!.fallback).not.toContain("No actor or SSH client reported.");
  });

  it("lists a matching request and reported SSH address only once", async () => {
    const body = JSON.parse(await fire("discord", {
      "cf-connecting-ip": "203.0.113.5",
      "x-mantis-ssh-client": "203.0.113.5 50022 22",
    })) as DiscordBody;
    expect(body.embeds[0]!.description.replace(/[`*]/g, "")).toContain("observed IP: 203.0.113.5");
    expect(body.embeds[0]!.description).not.toContain("Reported SSH client");
    expect(body.embeds[0]!.description).toContain("also reported SSH client");
    expect(body.embeds[0]!.description.match(/203\.0\.113\.5/g)).toHaveLength(1);
    expect(body.embeds[0]!.description).not.toContain("No actor or SSH client reported.");
  });
});

describe("edge chat alerts stay inside the platform length limits", () => {
  // Every anonymous-controlled value at once, each far over any limit and
  // made of the characters each escaper expands the most.
  // 3000 keeps all nine headers inside the 32 KiB header snapshot, so every
  // field is present in the alert.
  const HUGE = 3000;
  const hostile = (ch: string) => ({
    "cf-connecting-ip": ch.repeat(HUGE),
    "user-agent": ch.repeat(HUGE),
    referer: `https://example.com/${ch.repeat(HUGE)}`,
    "x-mantis-user": ch.repeat(HUGE),
    "x-mantis-host": ch.repeat(HUGE),
    "x-mantis-device": ch.repeat(HUGE),
    "x-mantis-event": ch.repeat(HUGE),
    "x-mantis-ssh-client": `x${ch.repeat(HUGE - 1)} 50022 22`,
    "x-mantis-sudo-cmd": ch.repeat(HUGE),
  });
  const HUGE_MEMO = "M".repeat(5000);

  it.each(["&", "<", "a"])("slack: rich text of %j stays inside message limits", async (ch) => {
    const body = JSON.parse(await fire("slack", hostile(ch), HUGE_MEMO)) as SlackBody;
    const { blocks, fallback } = body.attachments[0]!;
    expect(blocks[0]!.text!.text.length).toBeLessThanOrEqual(150);
    const spans = slackSpans(body);
    expect(spans.filter((part) => part.style?.code)).toHaveLength(3);
    for (const field of spans) {
      if (field.type === "date") continue;
      expect(field.type).toBe("text");
      expect(field.text.length).toBeLessThanOrEqual(400);
      expect(field.text.isWellFormed()).toBe(true);
    }
    expect(fallback).not.toMatch(/&(?!amp;|lt;|gt;)/);
    expect(fallback.length).toBeLessThanOrEqual(4000);
  });

  it.each(["_", "\\", "*", "a"])("discord: description of %j stays within 4096 chars and 6000 in total", async (ch) => {
    const body = JSON.parse(await fire("discord", hostile(ch), HUGE_MEMO)) as DiscordBody;
    const embed = body.embeds[0]!;
    expect(embed.title.length).toBeLessThanOrEqual(256);
    expect(embed.description.length).toBeLessThanOrEqual(4096);
    expect(embed.description.isWellFormed()).toBe(true);
    const fieldLength = (embed.fields ?? []).reduce((sum, field) => sum + field.name.length + field.value.length, 0);
    const total = embed.title.length + embed.description.length + (embed.footer?.text.length ?? 0) + fieldLength;
    expect(total).toBeLessThanOrEqual(6000);
  });

  it.each(["_", "\\", "a"])("teams: text runs of %j stay bounded", async (ch) => {
    const raw = await fire("teams", hostile(ch), HUGE_MEMO);
    expect(new TextEncoder().encode(raw).length).toBeLessThan(20 * 1024);
    const body = JSON.parse(raw) as TeamsBody;
    const blocks = body.attachments[0]!.content.body;
    const inlines = blocks.flatMap((block) => block.inlines ?? []);
    expect(blocks.flatMap((block) => block.items ?? [block]).some((block) => block.fontType === "Monospace" && block.wrap)).toBe(true);
    for (const block of blocks.flatMap((block) => [block, ...(block.items ?? [])])) {
      expect(block.text?.length ?? 0).toBeLessThanOrEqual(850);
      expect(block.text?.isWellFormed() ?? true).toBe(true);
    }
    for (const part of inlines) {
      expect(part.type).toBe("TextRun");
      expect(part.text.length).toBeLessThanOrEqual(400);
      expect(part.text.isWellFormed()).toBe(true);
    }
  });

  it("keeps both ends of an over-long memo without splitting a character", async () => {
    const memo = `Bastion ${"😀".repeat(400)} Melbourne`;
    const slack = JSON.parse(await fire("slack", {}, memo)) as SlackBody;
    const header = slack.attachments[0]!.blocks[0]!.text!.text;
    expect(header.length).toBeLessThanOrEqual(150);
    expect(header.isWellFormed()).toBe(true);
    expect(header).toMatch(/^Bastion .*…\u2060Melbourne$/);
    expect(slack.attachments[0]!.fallback.isWellFormed()).toBe(true);
    const discord = JSON.parse(await fire("discord", {}, memo)) as DiscordBody;
    expect(discord.embeds[0]!.title.length).toBeLessThanOrEqual(256);
    expect(discord.embeds[0]!.title.isWellFormed()).toBe(true);
    expect(discord.embeds[0]!.title).toMatch(/^Bastion .*…\u2060Melbourne$/);
  });

  it("leads with the actor and distinguishes the two IPs before diagnostics", async () => {
    const headers = {
      "cf-connecting-ip": "203.0.113.5",
      "user-agent": "curl/8.7.1",
      "x-mantis-user": "alice",
      "x-mantis-host": "prod-bastion",
      "x-mantis-ssh-client": "198.51.100.7 50022 22",
      "x-mantis-sudo-cmd": "systemctl restart nginx",
    };
    const slack = JSON.parse(await fire("slack", headers, "prod bastion")) as SlackBody;
    expect(slack.attachments[0]!.blocks[0]!.text!.text).toBe("prod bastion");
    expect(slack.attachments[0]!.fallback.replace(/\u00a0/g, " ")).toContain(
      "alice@prod-bastion ← reported IP: 198.51.100.7\nsudo systemctl restart nginx\nobserved IP: 203.0.113.5\nagent: “curl/8.7.1”",
    );
    expect(slackSpans(slack)).toContainEqual({
      type: "text", text: "alice@prod-bastion", style: { bold: true },
    });
    expect(slackSpans(slack)).toContainEqual(expect.objectContaining({ type: "text", text: "198.51.100.7" }));
    const discord = JSON.parse(await fire("discord", headers, "prod bastion")) as DiscordBody;
    expect(discord.embeds[0]!.title).toBe("prod bastion");
    expect(discord.embeds[0]!.description.replace(/[`*]/g, "").replace(/\u00a0/g, " ")).toContain(
      "alice@prod-bastion ← reported IP: 198.51.100.7\nsudo systemctl restart nginx\n\nobserved IP: 203.0.113.5",
    );
    expect(discord.embeds[0]!.fields).toBeUndefined();
    expect(discord.embeds[0]!.description).not.toContain("agent: “");
    expect(readable(discord.embeds[0]!.footer?.text)).toMatch(/^agent: “curl\/8\.7\.1”\nMantis Edge, [^\n]+, ref /);
  });

  it("keeps both addresses explicitly labelled when no actor is reported", async () => {
    const raw = await fire("discord", {
      "cf-connecting-ip": "203.0.113.5",
      "x-mantis-ssh-client": "198.51.100.7 50022 22",
    });
    const [embed] = (JSON.parse(raw) as DiscordBody).embeds;
    expect(embed?.description.replace(/[`*]/g, "")).toContain("reported IP: 198.51.100.7");
    expect(embed?.description.replace(/[`*]/g, "")).toContain("observed IP: 203.0.113.5");
    expect(embed?.description).toContain("reported");
    expect(embed?.description).not.toContain("undefined");
  });
});
