import { type DocOptions, splitUrl } from "./util";

/**
 * VPN and remote-desktop profiles — the files someone reaches for the moment
 * they want to get *further* into a network, and therefore good bait to leave
 * where lateral movement starts.
 *
 * Be clear about the trigger: neither of these beacons on its own. OpenVPN
 * speaks its own protocol and RDP speaks RDP, so pointing them at an HTTP
 * canary yields a failed connection, not a hit. What they are is *discovery*
 * bait — the canary URL sits in the file where anyone reading it will see it
 * (a profile-update endpoint, a workspace feed), and the hit comes when they
 * follow it. That is a weaker trigger than a .docx beacon, and the preset says
 * so rather than implying otherwise.
 */

export function generateOvpn(opts: DocOptions): Promise<Buffer> {
  const { host, port } = splitUrl(opts.url);
  const body = [
    "# OpenVPN profile — Corporate (full tunnel)",
    "# Issued 2026-02-11. Expires 2027-02-11.",
    `# Profile updates: ${opts.url}`,
    "#",
    "# If the tunnel fails to establish, re-download the profile from the",
    "# update URL above before contacting IT.",
    "",
    "client",
    "dev tun",
    "proto udp",
    `remote ${host} 1194`,
    "remote vpn-backup.internal.example.com 1194",
    "resolv-retry infinite",
    "nobind",
    "persist-key",
    "persist-tun",
    "remote-cert-tls server",
    "cipher AES-256-GCM",
    "auth SHA256",
    "verb 3",
    "",
    "auth-user-pass",
    "",
    "<ca>",
    "-----BEGIN CERTIFICATE-----",
    "MIIDQjCCAiqgAwIBAgIUL3xkFbQ2mNvR7hJlA3sWeQ1tYuIwDQYJKoZIhvcNAQEL",
    "BQAwEzERMA8GA1UEAwwIQ2hhbmdlTWUwHhcNMjYwMjExMDAwMDAwWhcNMjcwMjEx",
    "MDAwMDAwWjATMREwDwYDVQQDDAhDaGFuZ2VNZTCCASIwDQYJKoZIhvcNAQEBBQAD",
    "-----END CERTIFICATE-----",
    "</ca>",
    "",
    `# Split-tunnel routes are pushed by the server; see ${opts.url} for the`,
    "# current subnet list.",
    "",
  ].join("\n");
  return Promise.resolve(Buffer.from(body, "utf8"));
}

export function generateRdp(opts: DocOptions): Promise<Buffer> {
  const { host } = splitUrl(opts.url);
  // .rdp is a CRLF key:type:value file. `workspace id` and `workspacefeedurl`
  // are real RDP settings that legitimately hold an HTTPS URL, so the canary
  // sits in a slot that belongs there.
  const body = [
    "screen mode id:i:2",
    "use multimon:i:0",
    "desktopwidth:i:1920",
    "desktopheight:i:1080",
    "session bpp:i:32",
    `full address:s:${host}`,
    "audiomode:i:0",
    "redirectprinters:i:0",
    "redirectclipboard:i:1",
    "prompt for credentials:i:0",
    "authentication level:i:2",
    "username:s:EXAMPLE\\svc-rdp",
    "domain:s:EXAMPLE",
    "gatewayhostname:s:rdgw.internal.example.com",
    "gatewayusagemethod:i:1",
    "gatewaycredentialssource:i:4",
    `workspacefeedurl:s:${opts.url}`,
    "",
  ].join("\r\n");
  return Promise.resolve(Buffer.from(body, "utf8"));
}
