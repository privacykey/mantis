import { describe, expect, it } from "vitest";
import {
  detectChannelFromUrl,
  validateDestination,
} from "@/lib/notify/channels";

describe("validateDestination", () => {
  describe("slack", () => {
    it("accepts a valid hooks.slack.com URL", () => {
      expect(
        validateDestination("slack", "https://hooks.slack.com/services/T01/B02/abc").ok,
      ).toBe(true);
    });
    it("rejects a random URL", () => {
      const r = validateDestination("slack", "https://example.com/fake");
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/hooks\.slack\.com/);
    });
    it("rejects http (not https)", () => {
      expect(validateDestination("slack", "http://hooks.slack.com/services/x").ok).toBe(
        false,
      );
    });
  });

  describe("discord", () => {
    it("accepts discord.com", () => {
      expect(
        validateDestination("discord", "https://discord.com/api/webhooks/1/abc").ok,
      ).toBe(true);
    });
    it("accepts discordapp.com (legacy)", () => {
      expect(
        validateDestination("discord", "https://discordapp.com/api/webhooks/1/abc").ok,
      ).toBe(true);
    });
    it("rejects random URLs", () => {
      expect(validateDestination("discord", "https://example.com/webhook").ok).toBe(
        false,
      );
    });
  });

  describe("teams", () => {
    it("accepts *.webhook.office.com/webhookb2/", () => {
      expect(
        validateDestination(
          "teams",
          "https://contoso.webhook.office.com/webhookb2/abc",
        ).ok,
      ).toBe(true);
    });
    it("accepts outlook.office.com/webhook/", () => {
      expect(
        validateDestination("teams", "https://outlook.office.com/webhook/abc").ok,
      ).toBe(true);
    });
    it("rejects random URLs", () => {
      expect(validateDestination("teams", "https://example.com/teams").ok).toBe(
        false,
      );
    });
  });

  describe("email", () => {
    it("accepts valid", () => {
      expect(validateDestination("email", "alerts@example.com").ok).toBe(true);
    });
    it("rejects non-email", () => {
      expect(validateDestination("email", "not-an-email").ok).toBe(false);
    });
  });

  describe("webhook", () => {
    it("accepts https", () => {
      expect(validateDestination("webhook", "https://example.com/x").ok).toBe(true);
    });
    it("accepts http", () => {
      expect(validateDestination("webhook", "http://example.com/x").ok).toBe(true);
    });
    it("rejects ftp", () => {
      expect(validateDestination("webhook", "ftp://example.com/x").ok).toBe(false);
    });
  });

  describe("home_assistant", () => {
    it("accepts https /api/webhook/<id>", () => {
      expect(
        validateDestination(
          "home_assistant",
          "https://ha.example.com/api/webhook/mantis-abc12345",
        ).ok,
      ).toBe(true);
    });
    it("accepts http (LAN/tailnet)", () => {
      expect(
        validateDestination(
          "home_assistant",
          "http://homeassistant.local:8123/api/webhook/mantis-test",
        ).ok,
      ).toBe(true);
    });
    it("accepts trailing slash", () => {
      expect(
        validateDestination(
          "home_assistant",
          "https://ha.example.com/api/webhook/abc/",
        ).ok,
      ).toBe(true);
    });
    it("rejects non-webhook path", () => {
      const r = validateDestination(
        "home_assistant",
        "https://ha.example.com/api/states/light.kitchen",
      );
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/\/api\/webhook\/<id>/);
    });
    it("rejects bare host", () => {
      expect(
        validateDestination("home_assistant", "https://ha.example.com").ok,
      ).toBe(false);
    });
    it("rejects ftp", () => {
      expect(
        validateDestination("home_assistant", "ftp://ha.example.com/api/webhook/x")
          .ok,
      ).toBe(false);
    });
    it("rejects invalid URL", () => {
      expect(validateDestination("home_assistant", "not-a-url").ok).toBe(false);
    });
  });

  describe("common", () => {
    it("rejects empty target", () => {
      expect(validateDestination("webhook", "").ok).toBe(false);
    });
    it("rejects oversized target", () => {
      expect(validateDestination("webhook", "https://" + "a".repeat(2050)).ok).toBe(
        false,
      );
    });
  });
});

describe("detectChannelFromUrl", () => {
  it.each([
    ["https://hooks.slack.com/services/T/B/x", "slack"],
    ["https://discord.com/api/webhooks/1/2", "discord"],
    ["https://discordapp.com/api/webhooks/1/2", "discord"],
    ["https://contoso.webhook.office.com/webhookb2/x", "teams"],
    ["alerts@example.com", "email"],
    ["https://ha.example.com/api/webhook/mantis-abc", "home_assistant"],
    ["http://homeassistant.local:8123/api/webhook/x/", "home_assistant"],
    ["https://example.com/raw", "webhook"],
    ["nonsense", null],
  ])("detects %j as %j", (input, expected) => {
    expect(detectChannelFromUrl(input)).toBe(expected);
  });
});
