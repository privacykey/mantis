import { describe, expect, it } from "vitest";
import { parseHostContext } from "../src/host-context";

describe("parseHostContext (edge)", () => {
  it("returns null when no x-mantis-* headers are present", () => {
    expect(parseHostContext({})).toBeNull();
  });

  it("extracts the SSH client IP", () => {
    const ctx = parseHostContext({
      "x-mantis-source": "shell",
      "x-mantis-ssh-client": "203.0.113.42 54321 22",
    });
    expect(ctx?.ssh_client_ip).toBe("203.0.113.42");
  });

  it("handles all installer headers", () => {
    const ctx = parseHostContext({
      "x-mantis-source": "shell-sudo",
      "x-mantis-user": "alice",
      "x-mantis-host": "prod-bastion",
      "x-mantis-sudo-cmd": "apt update",
      "x-mantis-network-interface": "eth0",
      "x-mantis-tty": "/dev/pts/0",
    });
    expect(ctx).toMatchObject({
      source: "shell-sudo",
      user: "alice",
      host: "prod-bastion",
      sudo_cmd: "apt update",
      network_interface: "eth0",
      tty: "/dev/pts/0",
    });
  });

  it("retains all IoT context emitted by the helper and smart-home installers", () => {
    expect(parseHostContext({
      "x-mantis-source": "iot-network",
      "x-mantis-event": " unexpected-online ",
      "x-mantis-device": " garage-camera ",
      "x-mantis-entity-id": "binary_sensor.garage_camera",
      "x-mantis-automation": "Night watch",
      "x-mantis-area": "Garage",
      "x-mantis-iot-mac": "aa:bb:cc:dd:ee:ff",
      "x-mantis-iot-ip": "192.0.2.10",
    })).toMatchObject({
      source: "iot-network",
      event: "unexpected-online",
      device: "garage-camera",
      entity_id: "binary_sensor.garage_camera",
      automation: "Night watch",
      area: "Garage",
      iot_mac: "aa:bb:cc:dd:ee:ff",
      iot_ip: "192.0.2.10",
    });
  });

  it("recognizes an IoT event without shell headers or a source label", () => {
    expect(parseHostContext({ "x-mantis-device": "front-door" })).toMatchObject({ device: "front-door" });
    expect(parseHostContext({ "x-mantis-event": "   " })).toBeNull();
  });
});
