import { describe, expect, it } from "vitest";
import {
  ALL_INSTALL_TYPES,
  INSTALLER_META,
  buildInstaller,
  isHomeAssistantWebhookId,
  isInstallType,
} from "@mantis/core/installers";

describe("homeassistant-receiver installer", () => {
  const input = {
    url: "https://mantis.example.com/c/abc123def456",
    keyId: "00000000-0000-0000-0000-000000000001",
    memo: "SSH honeypot",
  };

  /** Top-level keys of the single automation entry, in file order. */
  const automationKeys = (content: string) =>
    [...content.matchAll(/^ {4}([a-z_]+):/gm)].map((m) => m[1]);

  it("is registered as an install type", () => {
    expect(isInstallType("homeassistant-receiver")).toBe(true);
    expect(ALL_INSTALL_TYPES).toContain("homeassistant-receiver");
    expect(INSTALLER_META["homeassistant-receiver"]).toMatchObject({
      os: "iot",
    });
  });

  it("emits a YAML automation skeleton scoped to the key", () => {
    const out = buildInstaller("homeassistant-receiver", input);

    expect(out.type).toBe("homeassistant-receiver");
    expect(out.os).toBe("iot");
    expect(out.filename).toMatch(/\.yaml$/);
    expect(out.mime).toMatch(/yaml/);

    // Memo is interpolated into the automation alias + heading.
    expect(out.content).toContain("SSH honeypot");
    // The short key id still names the key in the registration command.
    expect(out.content).toContain("mantis dest add 00000000 home_assistant");
    // Example actions are present.
    expect(out.content).toContain("switch.turn_off");
    expect(out.content).toContain("notify.mobile_app_iphone");
    // Tailscale note is surfaced.
    expect(out.notes).toMatch(/ALLOW_PRIVATE_WEBHOOKS=1/);
    expect(out.notes).toMatch(/Tailscale/i);
  });

  it("generates an unguessable webhook id that owes nothing to the key", () => {
    const out = buildInstaller("homeassistant-receiver", input);
    // 256 random bits, hex: nothing derived from the key id or the URL.
    expect(out.webhookId).toMatch(/^mantis-[0-9a-f]{64}$/);
    expect(isHomeAssistantWebhookId(out.webhookId!)).toBe(true);
    expect(out.content).not.toContain("mantis-00000000");
    expect(out.webhookId).not.toContain("abc123def456");

    // A fresh id on every render…
    const ids = new Set(
      Array.from({ length: 50 }, () => buildInstaller("homeassistant-receiver", input).webhookId),
    );
    expect(ids.size).toBe(50);
    // …and not all-zero / constant bytes.
    expect(new Set(out.webhookId!.slice("mantis-".length)).size).toBeGreaterThan(4);
  });

  it("uses the same id for the automation and the registration command", () => {
    const out = buildInstaller("homeassistant-receiver", input);
    const id = out.webhookId!;
    expect(out.content).toContain(`        webhook_id: "${id}"`);
    expect(out.content).toContain(`https://<your-ha-host>/api/webhook/${id}\n`);
    expect(out.install.join("\n")).toContain(
      `mantis dest add 00000000 home_assistant https://<your-ha-host>/api/webhook/${id}`,
    );
    // Exactly one id appears anywhere in the output.
    const seen = new Set(
      [out.content, ...out.install].flatMap((s) => s.match(/mantis-[0-9a-f]{16,}/g) ?? []),
    );
    expect([...seen]).toEqual([id]);
  });

  it("honours a caller-supplied webhook id", () => {
    const webhookId = "mantis-my.own_id~1";
    const out = buildInstaller("homeassistant-receiver", { ...input, webhookId });
    expect(out.webhookId).toBe(webhookId);
    expect(out.content).toContain(`webhook_id: "${webhookId}"`);
    expect(out.install.join("\n")).toContain(`/api/webhook/${webhookId}`);
    // Rendering again with the id handed back gives the same file.
    const again = buildInstaller("homeassistant-receiver", { ...input, webhookId: out.webhookId });
    expect(again.content).toBe(out.content);
  });

  it.each(['x"\n    actions: []', "a b", "a/b", "é", "", "x".repeat(129), "a#b", "a'b"])(
    "rejects webhook id %j rather than emit it",
    (webhookId) => {
      expect(isHomeAssistantWebhookId(webhookId)).toBe(false);
      expect(() => buildInstaller("homeassistant-receiver", { ...input, webhookId })).toThrow(
        /webhookId/,
      );
    },
  );

  it("other installers ignore webhookId", () => {
    const out = buildInstaller("homeassistant", { ...input, webhookId: 'x"\n' });
    expect(out.webhookId).toBeUndefined();
    expect(out.content).not.toContain('x"');
  });

  it("filters the activation ping in conditions, before any action", () => {
    const out = buildInstaller("homeassistant-receiver", { ...input, webhookId: "w" });
    expect(automationKeys(out.content)).toEqual([
      "mode",
      "max",
      "triggers",
      "conditions",
      "actions",
    ]);
    const conditions = out.content.slice(
      out.content.indexOf("    conditions:\n"),
      out.content.indexOf("    actions:\n"),
    );
    expect(conditions).toContain("      - condition: template\n");
    expect(conditions).toContain(
      `        value_template: "{{ trigger.json.type != 'mantis.activation' }}"\n`,
    );
    // No longer an if/stop buried in the action list.
    expect(out.content).not.toMatch(/^\s*- stop:/m);
    expect(out.content).not.toMatch(/^\s*- if:/m);
    // The queue a burst can build is bounded.
    expect(out.content).toMatch(/^ {4}mode: queued\b.*\n {4}max: 10$/m);
  });

  it("points at the server log for refused destinations", () => {
    const out = buildInstaller("homeassistant-receiver", input);
    for (const text of [out.content, out.notes!]) {
      expect(text).not.toContain("resolves to a private address");
      // The server's constant refusal message (comment lines re-joined).
      expect(text.replace(/\n#\s+/g, " ")).toContain(
        "destination refused: it does not resolve to a public address",
      );
      expect(text).toMatch(/server log/);
    }
  });

  it("says a supplied webhook id is stable, and a generated one is per render", () => {
    const supplied = buildInstaller("homeassistant-receiver", {
      ...input,
      webhookId: "mantis-0123456789abcdef",
    });
    expect(supplied.content).toContain('webhook_id: "mantis-0123456789abcdef"');
    for (const text of [supplied.content, supplied.notes!]) {
      expect(text).not.toMatch(/every (time|render)/);
      expect(text).toMatch(/only credential between Mantis and HA/);
    }
    const generated = buildInstaller("homeassistant-receiver", input);
    expect(generated.content).toMatch(/generated every time this installer is rendered/);
    expect(generated.notes).toMatch(/on every render/);
  });
});
