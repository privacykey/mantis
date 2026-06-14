// Literal-IP SSRF guard for the edge worker. Cloudflare Workers can't do DNS
// resolution, so the worker can only reject webhook targets that are *literal*
// private / loopback / link-local / metadata IPs. Hostname targets are gated
// by MANTIS_EDGE_WEBHOOK_ALLOWLIST instead (see index.ts). This mirrors the
// stateful server's isPrivateAddress in src/lib/ssrf.ts — KEEP IN SYNC.

export function isPrivateLiteralHost(hostname: string): boolean {
  const host = hostname.replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return isPrivateV4(host);
  if (host.includes(":")) return isPrivateV6(host);
  return false; // not a literal IP — can't resolve at the edge
}

function isPrivateV4(addr: string): boolean {
  const parts = addr.split(".").map((p) => Number(p));
  if (
    parts.length !== 4 ||
    parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)
  ) {
    return true; // malformed → treat as unsafe
  }
  const [a = 0, b = 0, c = 0] = parts;
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // RFC1918
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local + cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 0) return true; // 192.0.0.0/24 (+ TEST-NET-1)
  if (a === 192 && b === 88 && c === 99) return true; // 6to4 relay anycast
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a >= 224) return true; // multicast + reserved
  return false;
}

/**
 * Expand a textual IPv6 address (including `::` compression and a trailing
 * embedded IPv4 such as `::ffff:1.2.3.4`) to its 16 raw bytes. Returns null
 * for anything we can't parse so callers can fail closed. KEEP IN SYNC with
 * src/lib/ssrf.ts.
 */
function ipv6ToBytes(addr: string): Uint8Array | null {
  let s = addr.toLowerCase().replace(/%.*$/, ""); // strip zone id

  const lastColon = s.lastIndexOf(":");
  if (lastColon !== -1 && s.slice(lastColon + 1).includes(".")) {
    const v4 = s.slice(lastColon + 1).split(".").map(Number);
    if (
      v4.length !== 4 ||
      v4.some((n) => !Number.isInteger(n) || n < 0 || n > 255)
    ) {
      return null;
    }
    const hi = (((v4[0] ?? 0) << 8) | (v4[1] ?? 0)).toString(16);
    const lo = (((v4[2] ?? 0) << 8) | (v4[3] ?? 0)).toString(16);
    s = `${s.slice(0, lastColon + 1)}${hi}:${lo}`;
  }

  const parts = s.split("::");
  if (parts.length > 2) return null;
  const head = parts[0] ? parts[0].split(":") : [];
  const tail = parts.length === 2 && parts[1] ? parts[1].split(":") : [];

  let groups: string[];
  if (parts.length === 2) {
    const missing = 8 - (head.length + tail.length);
    if (missing < 0) return null;
    groups = [...head, ...Array<string>(missing).fill("0"), ...tail];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;

  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    const g = groups[i] ?? "";
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    const n = parseInt(g, 16);
    bytes[i * 2] = (n >> 8) & 0xff;
    bytes[i * 2 + 1] = n & 0xff;
  }
  return bytes;
}

function isPrivateV6(addr: string): boolean {
  const bytes = ipv6ToBytes(addr);
  if (!bytes) return true; // unparseable → treat as unsafe

  if (bytes.every((b) => b === 0)) return true; // :: unspecified
  if (bytes.slice(0, 15).every((b) => b === 0) && bytes[15] === 1) return true; // ::1 loopback

  const b0 = bytes[0] ?? 0;
  const b1 = bytes[1] ?? 0;
  if (b0 === 0xfe && (b1 & 0xc0) === 0x80) return true; // fe80::/10 link-local
  if ((b0 & 0xfe) === 0xfc) return true; // fc00::/7 ULA
  if (b0 === 0xff) return true; // ff00::/8 multicast

  // IPv6 forms that embed an IPv4 address: decode the low 32 bits and apply the
  // v4 rules so loopback / metadata / RFC1918 can't slip through a transition
  // prefix. This is what the old dotted-only ::ffff: regex missed.
  const embeddedLowV4 = () =>
    isPrivateV4(`${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`);
  const zeroThrough = (end: number) => bytes.slice(0, end).every((b) => b === 0);

  if (zeroThrough(10) && bytes[10] === 0xff && bytes[11] === 0xff) {
    return embeddedLowV4(); // ::ffff:0:0/96 IPv4-mapped
  }
  if (zeroThrough(12)) return embeddedLowV4(); // ::/96 IPv4-compatible (deprecated)
  if (
    b0 === 0x00 &&
    b1 === 0x64 &&
    bytes[2] === 0xff &&
    bytes[3] === 0x9b &&
    bytes.slice(4, 12).every((b) => b === 0)
  ) {
    return embeddedLowV4(); // 64:ff9b::/96 NAT64
  }
  if (b0 === 0x20 && b1 === 0x02) {
    return isPrivateV4(`${bytes[2]}.${bytes[3]}.${bytes[4]}.${bytes[5]}`); // 2002::/16 6to4
  }
  return false;
}
