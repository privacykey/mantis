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
};

function clean(v: string | undefined): string | null {
  if (!v) return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

export function parseHostContext(
  headers: Record<string, string>,
): HostContext | null {
  const get = (n: string) => headers[n] ?? headers[n.toLowerCase()];
  const source = clean(get("x-mantis-source"));
  const user = clean(get("x-mantis-user"));
  const host = clean(get("x-mantis-host"));
  const ssh_client = clean(get("x-mantis-ssh-client"));
  const ssh_connection = clean(get("x-mantis-ssh-connection"));
  const tty = clean(get("x-mantis-tty"));
  const sudo_cmd = clean(get("x-mantis-sudo-cmd"));
  const network_interface = clean(get("x-mantis-network-interface"));

  if (
    !source &&
    !user &&
    !host &&
    !ssh_client &&
    !ssh_connection &&
    !tty &&
    !sudo_cmd &&
    !network_interface
  ) {
    return null;
  }

  return {
    source,
    user,
    host,
    ssh_client,
    ssh_connection,
    ssh_client_ip: ssh_client ? (ssh_client.split(/\s+/)[0] ?? null) : null,
    tty,
    sudo_cmd,
    network_interface,
  };
}
