import { describe, expect, it } from "vitest";
import { parseHostContext } from "@/lib/installers/headers";

describe("parseHostContext", () => {
  it("returns null when no X-Mantis-* headers are present", () => {
    expect(parseHostContext({})).toBeNull();
    expect(parseHostContext({ "user-agent": "curl" })).toBeNull();
    expect(parseHostContext(null)).toBeNull();
  });

  it("parses source / user / host", () => {
    const ctx = parseHostContext({
      "x-mantis-source": "shell",
      "x-mantis-user": "alice",
      "x-mantis-host": "prod-bastion",
    });
    expect(ctx).toMatchObject({
      source: "shell",
      user: "alice",
      host: "prod-bastion",
    });
  });

  it("extracts the SSH client IP from the sshd-format string", () => {
    const ctx = parseHostContext({
      "x-mantis-source": "shell",
      "x-mantis-ssh-client": "203.0.113.42 54321 22",
    });
    expect(ctx?.ssh_client).toBe("203.0.113.42 54321 22");
    expect(ctx?.ssh_client_ip).toBe("203.0.113.42");
  });

  it("handles missing ssh-client gracefully", () => {
    const ctx = parseHostContext({ "x-mantis-source": "macos-login" });
    expect(ctx?.ssh_client).toBeNull();
    expect(ctx?.ssh_client_ip).toBeNull();
  });

  it("treats empty header values as null", () => {
    const ctx = parseHostContext({
      "x-mantis-source": "shell",
      "x-mantis-user": "   ",
      "x-mantis-host": "",
    });
    expect(ctx?.user).toBeNull();
    expect(ctx?.host).toBeNull();
  });

  it("captures sudo_cmd and network_interface", () => {
    const ctx = parseHostContext({
      "x-mantis-source": "shell-sudo",
      "x-mantis-sudo-cmd": "apt update --quiet",
    });
    expect(ctx?.sudo_cmd).toBe("apt update --quiet");

    const ctx2 = parseHostContext({
      "x-mantis-source": "linux-network",
      "x-mantis-network-interface": "wlan0",
    });
    expect(ctx2?.network_interface).toBe("wlan0");
  });

  it("captures structured IoT and smart-home event fields", () => {
    const ctx = parseHostContext({
      "x-mantis-source": "homeassistant",
      "x-mantis-event": "door-opened",
      "x-mantis-device": "Front Door",
      "x-mantis-entity-id": "binary_sensor.front_door",
      "x-mantis-automation": "Mantis - front door opened",
      "x-mantis-area": "entry",
      "x-mantis-iot-mac": "aa:bb:cc:dd:ee:ff",
      "x-mantis-iot-ip": "192.168.1.50",
    });
    expect(ctx).toMatchObject({
      source: "homeassistant",
      event: "door-opened",
      device: "Front Door",
      entity_id: "binary_sensor.front_door",
      automation: "Mantis - front door opened",
      area: "entry",
      iot_mac: "aa:bb:cc:dd:ee:ff",
      iot_ip: "192.168.1.50",
    });
  });

  it("expects lowercased keys (matches snapshotHeaders output)", () => {
    // snapshotHeaders() always lowercases via Node's Headers iterator,
    // so the parser only handles lowercase keys. An uppercase key is a
    // caller bug, not something we paper over.
    const ctx = parseHostContext({ "X-Mantis-Source": "shell" });
    expect(ctx).toBeNull();
  });
});
