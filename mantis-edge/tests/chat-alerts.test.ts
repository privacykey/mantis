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

type SlackBody = {
  text: string;
  blocks: Array<{
    type: string;
    text?: { type: string; text: string; verbatim?: boolean };
    fields?: Array<{ type: string; text: string }>;
  }>;
};
type DiscordBody = {
  embeds: Array<{
    title: string;
    description?: string;
    url?: string;
    fields: Array<{ name: string; value: string }>;
  }>;
};
type TeamsBody = {
  attachments: Array<{
    content: {
      body: Array<{
        type: string;
        text?: string;
        facts?: Array<{ title: string; value: string }>;
      }>;
    };
  }>;
};

describe("edge chat alerts never link the live trigger", () => {
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
    // What is shown instead: a short prefix of the blob and the host.
    expect(raw).toContain(`${BLOB.slice(0, 10)}…`);
    expect(raw).toContain(HOST);
  });

  it("slack marks the label verbatim so the host is not auto-linked", async () => {
    const body = JSON.parse(await fire("slack")) as SlackBody;
    const label = body.blocks[1]!.text!;
    expect(label.verbatim).toBe(true);
    expect(label.text).toMatch(/^Edge canary `AQx1Yz-aB3…` on `mantis-edge\.example\.workers\.dev` · /);
  });

  it("discord has no title link", async () => {
    const body = JSON.parse(await fire("discord")) as DiscordBody;
    expect(body.embeds[0]).not.toHaveProperty("url");
    expect(body.embeds[0]!.description).toBe(
      "Edge canary `AQx1Yz-aB3…` on `mantis-edge.example.workers.dev`",
    );
  });

  it("teams shows plain text in place of the markdown link", async () => {
    const body = JSON.parse(await fire("teams")) as TeamsBody;
    expect(body.attachments[0]!.content.body[1]!.text).toBe(
      "Edge canary AQx1Yz-aB3… on mantis-edge.example.workers.dev",
    );
    // An underscore in the fragment is escaped, not rendered as emphasis.
    const other = JSON.parse(
      await fire("teams", {}, undefined, `https://${HOST}/c/A_b_c_d${"E".repeat(60)}`),
    ) as TeamsBody;
    expect(other.attachments[0]!.content.body[1]!.text).toBe(
      "Edge canary A\\_b\\_c\\_dEEE… on mantis-edge.example.workers.dev",
    );
  });

  it("the raw webhook payload still carries the URL as machine data", async () => {
    const body = JSON.parse(await fire("webhook")) as { key: { url: string } };
    expect(body.key.url).toBe(TRIGGER_URL);
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
    "x-mantis-ssh-client": `${ch.repeat(HUGE)} 50022 22`,
    "x-mantis-sudo-cmd": ch.repeat(HUGE),
  });
  const HUGE_MEMO = "M".repeat(5000);

  it.each(["&", "<", "a"])("slack: fields of %j stay within 2000 chars and 10 fields", async (ch) => {
    const body = JSON.parse(await fire("slack", hostile(ch), HUGE_MEMO)) as SlackBody;
    const [header, label, section] = body.blocks;
    expect(header!.text!.text.length).toBeLessThanOrEqual(150);
    expect(label!.text!.text.length).toBeLessThanOrEqual(3000);
    expect(section!.fields!.length).toBe(8);
    expect(section!.fields!.length).toBeLessThanOrEqual(10);
    for (const field of section!.fields!) {
      expect(field.text.length, field.text.slice(0, 20)).toBeLessThanOrEqual(2000);
      expect(field.text.length).toBeLessThanOrEqual(300);
      // No entity cut in half by the truncation.
      expect(field.text).not.toMatch(/&(?!amp;|lt;|gt;)/);
      // No lone surrogate left at the cut.
      expect(field.text.isWellFormed()).toBe(true);
    }
    expect(body.text.length).toBeLessThanOrEqual(400);
  });

  it.each(["_", "\\", "*", "a"])("discord: fields of %j stay within 1024 chars and 6000 in total", async (ch) => {
    const body = JSON.parse(await fire("discord", hostile(ch), HUGE_MEMO)) as DiscordBody;
    const embed = body.embeds[0]!;
    expect(embed.title.length).toBeLessThanOrEqual(256);
    expect(embed.fields.length).toBe(8);
    expect(embed.fields.length).toBeLessThanOrEqual(25);
    let total = embed.title.length + (embed.description?.length ?? 0);
    for (const field of embed.fields) {
      expect(field.name.length).toBeLessThanOrEqual(256);
      expect(field.value.length).toBeGreaterThan(0);
      expect(field.value.length, field.name).toBeLessThanOrEqual(1024);
      expect(field.value.isWellFormed()).toBe(true);
      total += field.name.length + field.value.length;
    }
    expect(total).toBeLessThanOrEqual(6000);
    // Escaped values end on a whole escape pair, never a dangling backslash.
    for (const field of embed.fields.filter((f) => f.name !== "Sudo cmd")) {
      const trailing = /(\\*)…$/.exec(field.value)?.[1] ?? "";
      expect(trailing.length % 2, field.name).toBe(0);
    }
  });

  it.each(["_", "\\", "a"])("teams: facts of %j stay bounded", async (ch) => {
    const raw = await fire("teams", hostile(ch), HUGE_MEMO);
    expect(new TextEncoder().encode(raw).length).toBeLessThan(20 * 1024);
    const body = JSON.parse(raw) as TeamsBody;
    const [title, label, factSet] = body.attachments[0]!.content.body;
    expect(title!.text!.length).toBeLessThanOrEqual(400);
    expect(label!.text!.length).toBeLessThanOrEqual(400);
    for (const fact of factSet!.facts!) {
      expect(fact.value.length, fact.title).toBeLessThanOrEqual(300);
      const trailing = /(\\*)…$/.exec(fact.value)?.[1] ?? "";
      expect(trailing.length % 2, fact.title).toBe(0);
    }
  });

  it("truncates an over-long memo without splitting a character", async () => {
    const memo = "😀".repeat(400);
    const slack = JSON.parse(await fire("slack", {}, memo)) as SlackBody;
    expect(slack.blocks[0]!.text!.text.length).toBeLessThanOrEqual(150);
    expect(slack.blocks[0]!.text!.text.isWellFormed()).toBe(true);
    expect(slack.text.isWellFormed()).toBe(true);
    const discord = JSON.parse(await fire("discord", {}, memo)) as DiscordBody;
    expect(discord.embeds[0]!.title.length).toBeLessThanOrEqual(256);
    expect(discord.embeds[0]!.title.isWellFormed()).toBe(true);
  });

  it("leaves ordinary values untouched", async () => {
    const headers = {
      "cf-connecting-ip": "203.0.113.5",
      "user-agent": "curl/8.7.1",
      "x-mantis-user": "alice",
      "x-mantis-host": "prod-bastion",
      "x-mantis-ssh-client": "198.51.100.7 50022 22",
      "x-mantis-sudo-cmd": "systemctl restart nginx",
    };
    const slack = JSON.parse(await fire("slack", headers, "prod bastion")) as SlackBody;
    expect(slack.blocks[0]!.text!.text).toBe("🪤 prod bastion");
    expect(slack.blocks[2]!.fields!.map((f) => f.text)).toEqual([
      "*IP*\n203.0.113.5",
      "*UA*\ncurl/8.7.1",
      "*User*\nalice",
      "*Host*\nprod-bastion",
      "*SSH from*\n198.51.100.7",
      "*Sudo cmd*\n`systemctl restart nginx`",
    ]);
    const discord = JSON.parse(await fire("discord", headers, "prod bastion")) as DiscordBody;
    expect(discord.embeds[0]!.title).toBe("Mantis triggered: prod bastion");
    expect(discord.embeds[0]!.fields.map((f) => [f.name, f.value])).toEqual([
      ["IP", "203.0.113.5"],
      ["UA", "curl/8.7.1"],
      ["User", "alice"],
      ["Host", "prod-bastion"],
      ["SSH from", "198.51.100.7"],
      ["Sudo cmd", "`systemctl restart nginx`"],
    ]);
  });
});
