import { describe, expect, it } from "vitest";
import {
  ALL_INSTALL_TYPES,
  INSTALLER_META,
  buildInstaller,
  isInstallType,
} from "@/lib/installers";

describe("homeassistant-receiver installer", () => {
  const input = {
    url: "https://mantis.example.com/c/abc123def456",
    keyId: "00000000-0000-0000-0000-000000000001",
    memo: "SSH honeypot",
  };

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
    // Short key id (first 8 chars) drives the suggested webhook_id.
    expect(out.content).toContain("mantis-00000000");
    expect(out.content).toContain('webhook_id: "mantis-00000000"');
    // Activation ping is filtered.
    expect(out.content).toContain("mantis.activation");
    // Example actions are present.
    expect(out.content).toContain("switch.turn_off");
    expect(out.content).toContain("notify.mobile_app_iphone");
    // Tailscale note is surfaced.
    expect(out.notes).toMatch(/ALLOW_PRIVATE_WEBHOOKS=1/);
    expect(out.notes).toMatch(/Tailscale/i);
  });
});
