import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ALL_CHANNELS, EDGE_CHANNELS } from "../src/lib/channels.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");

// The CLI's channel list used to be copy-pasted into five files. They drifted:
// `home_assistant` existed in the server schema, the senders and the CLI's own
// NotificationChannel type, but four copies omitted it — so the CLI rejected a
// channel the server fully supports. These tests pin the list to the server
// schema and keep the copies from coming back.

describe("CLI notification channels", () => {
  it("matches the server's notificationChannelEnum exactly", async () => {
    const schema = await readFile(
      resolve(repoRoot, "src/db/schema.ts"),
      "utf8",
    );
    const block = schema.match(
      /export const notificationChannelEnum = pgEnum\(\s*"notification_channel",\s*\[([^\]]*)\]/,
    );
    expect(block, "notificationChannelEnum not found in schema.ts").toBeTruthy();
    const serverChannels = [...block![1]!.matchAll(/"([a-z_]+)"/g)].map(
      (m) => m[1]!,
    );

    expect([...ALL_CHANNELS].sort()).toEqual([...serverChannels].sort());
  });

  it("includes home_assistant (the channel that went missing)", () => {
    expect(ALL_CHANNELS).toContain("home_assistant");
  });

  it("has no duplicates", () => {
    expect(new Set(ALL_CHANNELS).size).toBe(ALL_CHANNELS.length);
  });

  it("keeps edge channels a strict subset of all channels", () => {
    for (const c of EDGE_CHANNELS) {
      expect(ALL_CHANNELS, `edge channel ${c}`).toContain(c);
    }
    expect(EDGE_CHANNELS.length).toBeLessThan(ALL_CHANNELS.length);
  });

  it("offers only channels the edge worker can actually format", async () => {
    // The worker has no SMTP and no Home Assistant formatter; offering those
    // in `mantis edge mint` would mint URLs whose alerts never render.
    const forward = await readFile(
      resolve(repoRoot, "mantis-edge/src/forward.ts"),
      "utf8",
    );
    for (const c of EDGE_CHANNELS) {
      if (c === "webhook") continue; // the default path, not a `case`
      expect(forward, `forward.ts should handle ${c}`).toContain(`case "${c}"`);
    }
    for (const c of ALL_CHANNELS) {
      if ((EDGE_CHANNELS as readonly string[]).includes(c)) continue;
      expect(forward, `forward.ts should NOT handle ${c}`).not.toContain(
        `case "${c}"`,
      );
    }
  });

  it("is the single source used by the command surfaces", async () => {
    // Guards against a future copy-paste reintroducing a private list.
    for (const rel of [
      "cli/src/commands/new.ts",
      "cli/src/commands/bulk-create.ts",
      "cli/src/commands/destinations.ts",
      "cli/src/commands/completion.ts",
      "cli/src/index.ts",
    ]) {
      const src = await readFile(resolve(repoRoot, rel), "utf8");
      expect(src, `${rel} should import the shared list`).toMatch(
        /ALL_CHANNELS|EDGE_CHANNELS/,
      );
      expect(
        src.includes('"discord",\n  "teams",\n]'),
        `${rel} still declares a local channel array`,
      ).toBe(false);
    }
  });
});
