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
});
