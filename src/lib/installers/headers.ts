/**
 * Parses the X-Mantis-* headers our installer snippets emit into a structured
 * host context object. Headers without these prefixes are ignored.
 *
 * Header schema (in order of usefulness):
 *   X-Mantis-Source             — installer label ("shell", "macos-login", etc.)
 *   X-Mantis-User               — OS user account ($USER / $env:USERNAME)
 *   X-Mantis-Host               — local hostname
 *   X-Mantis-SSH-Client         — sshd-set "<ip> <port> <port>" (shell only)
 *   X-Mantis-SSH-Connection     — sshd-set "<cip> <cport> <sip> <sport>" (shell only)
 *   X-Mantis-TTY                — pty path (shell only)
 *   X-Mantis-Sudo-Cmd           — original args passed to sudo (shell-sudo only)
 *   X-Mantis-Network-Interface  — network device name (linux-network only)
 *   X-Mantis-Event              — structured event label ("door-opened", etc.)
 *   X-Mantis-Device             — IoT/smart-home device name
 *   X-Mantis-Entity-Id          — Home Assistant/Scrypted entity/device id
 *   X-Mantis-Automation         — automation or scene name
 *   X-Mantis-Area               — room/area label
 *   X-Mantis-Iot-Mac            — device MAC address when known
 *   X-Mantis-Iot-Ip             — device IP address when known
 */
export type HostContext = {
  source: string | null;
  user: string | null;
  host: string | null;
  ssh_client: string | null;
  ssh_connection: string | null;
  ssh_client_ip: string | null;
  tty: string | null;
  sudo_cmd: string | null;
  network_interface: string | null;
  event: string | null;
  device: string | null;
  entity_id: string | null;
  automation: string | null;
  area: string | null;
  iot_mac: string | null;
  iot_ip: string | null;
};

function clean(v: string | undefined): string | null {
  if (v === undefined) return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

function getHeader(
  headers: Record<string, string>,
  name: string,
): string | undefined {
  // Headers are usually lowercased by our snapshotHeaders; check both cases.
  return headers[name] ?? headers[name.toLowerCase()];
}

export function parseHostContext(
  headers: Record<string, string> | null | undefined,
): HostContext | null {
  if (!headers || typeof headers !== "object") return null;

  const source = clean(getHeader(headers, "x-mantis-source"));
  const user = clean(getHeader(headers, "x-mantis-user"));
  const host = clean(getHeader(headers, "x-mantis-host"));
  const ssh_client = clean(getHeader(headers, "x-mantis-ssh-client"));
  const ssh_connection = clean(getHeader(headers, "x-mantis-ssh-connection"));
  const tty = clean(getHeader(headers, "x-mantis-tty"));
  const sudo_cmd = clean(getHeader(headers, "x-mantis-sudo-cmd"));
  const network_interface = clean(
    getHeader(headers, "x-mantis-network-interface"),
  );
  const event = clean(getHeader(headers, "x-mantis-event"));
  const device = clean(getHeader(headers, "x-mantis-device"));
  const entity_id = clean(getHeader(headers, "x-mantis-entity-id"));
  const automation = clean(getHeader(headers, "x-mantis-automation"));
  const area = clean(getHeader(headers, "x-mantis-area"));
  const iot_mac = clean(getHeader(headers, "x-mantis-iot-mac"));
  const iot_ip = clean(getHeader(headers, "x-mantis-iot-ip"));

  // If nothing was set, this hit didn't come from one of our installers.
  if (
    !source &&
    !user &&
    !host &&
    !ssh_client &&
    !ssh_connection &&
    !tty &&
    !sudo_cmd &&
    !network_interface &&
    !event &&
    !device &&
    !entity_id &&
    !automation &&
    !area &&
    !iot_mac &&
    !iot_ip
  ) {
    return null;
  }

  return {
    source,
    user,
    host,
    ssh_client,
    ssh_connection,
    // sshd format: "<client_ip> <client_port> <server_port>"
    ssh_client_ip: ssh_client ? (ssh_client.split(/\s+/)[0] ?? null) : null,
    tty,
    sudo_cmd,
    network_interface,
    event,
    device,
    entity_id,
    automation,
    area,
    iot_mac,
    iot_ip,
  };
}
