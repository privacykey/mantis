import { lookup } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import { isIP } from "node:net";

/** True for RFC1918, loopback, link-local/metadata, CGNAT, multicast, IPv6 ULA. */
export function isPrivateAddress(addr: string): boolean {
  const v = isIP(addr);
  if (v === 4) return isPrivateV4(addr);
  if (v === 6) return isPrivateV6(addr);
  return false;
}

function isPrivateV4(addr: string): boolean {
  const parts = addr.split(".").map((p) => Number(p));
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    return true; // malformed → treat as unsafe
  }
  const [a = 0, b = 0, c = 0] = parts;
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // RFC1918
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local + AWS/GCP/Azure metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 0) return true; // 192.0.0.0/24 IETF protocol assignments (+ TEST-NET-1 192.0.2.0/24)
  if (a === 192 && b === 88 && c === 99) return true; // 192.88.99.0/24 6to4 relay anycast
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 benchmarking
  if (a === 100 && b >= 64 && b <= 127) return true; // RFC6598 CGNAT
  if (a >= 224) return true; // multicast + reserved (224.0.0.0/4, 240.0.0.0/4)
  return false;
}

/**
 * Expand a textual IPv6 address (including `::` compression and a trailing
 * embedded IPv4 such as `::ffff:1.2.3.4`) to its 16 raw bytes. Returns null
 * for anything we can't parse so callers can fail closed.
 */
function ipv6ToBytes(addr: string): Uint8Array | null {
  let s = addr.toLowerCase().replace(/%.*$/, ""); // strip zone id

  // Fold a trailing dotted-IPv4 group into two hextets so the parser below
  // only ever deals with hex groups.
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
  if (parts.length > 2) return null; // more than one "::" is illegal
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

  // ::ffff:0:0/96 IPv4-mapped (hex or dotted) and ::/96 IPv4-compatible (deprecated)
  if (zeroThrough(10) && bytes[10] === 0xff && bytes[11] === 0xff) {
    return embeddedLowV4();
  }
  if (zeroThrough(12)) return embeddedLowV4();
  // 64:ff9b::/96 NAT64 well-known prefix
  if (
    b0 === 0x00 &&
    b1 === 0x64 &&
    bytes[2] === 0xff &&
    bytes[3] === 0x9b &&
    bytes.slice(4, 12).every((b) => b === 0)
  ) {
    return embeddedLowV4();
  }
  // 2002::/16 6to4 — the embedded IPv4 sits in bytes 2..5
  if (b0 === 0x20 && b1 === 0x02) {
    return isPrivateV4(`${bytes[2]}.${bytes[3]}.${bytes[4]}.${bytes[5]}`);
  }
  return false;
}

export class UnsafeUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeUrlError";
  }
}

function allowPrivateWebhooks(): boolean {
  return process.env.ALLOW_PRIVATE_WEBHOOKS === "1";
}

/**
 * Pre-flight gate: scheme must be http(s) and (unless ALLOW_PRIVATE_WEBHOOKS=1)
 * every DNS-resolved address must be public. Throws UnsafeUrlError otherwise.
 * Does NOT close the DNS-rebinding TOCTOU window — pair with `redirect: "manual"`.
 */
export async function assertSafeWebhookUrl(target: string): Promise<void> {
  let u: URL;
  try {
    u = new URL(target);
  } catch {
    throw new UnsafeUrlError("invalid URL");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new UnsafeUrlError(`scheme ${u.protocol} not allowed`);
  }
  if (allowPrivateWebhooks()) return;

  const host = u.hostname;
  if (isIP(host)) {
    if (isPrivateAddress(host)) {
      throw new UnsafeUrlError(`${host} resolves to a private address`);
    }
    return;
  }
  const records = await lookup(host, { all: true });
  if (records.length === 0) {
    throw new UnsafeUrlError(`${host} did not resolve`);
  }
  for (const r of records) {
    if (isPrivateAddress(r.address)) {
      throw new UnsafeUrlError(
        `${host} resolves to private address ${r.address}`,
      );
    }
  }
}

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;

/**
 * Drop-in for `dns.lookup` (undici connector signature) that re-resolves the
 * host and rejects if ANY resolved address is private. Wiring this into the
 * dispatcher used for the actual connection closes the DNS-rebinding TOCTOU
 * window: undici connects to exactly the address this returns, and we only
 * return addresses we just validated. Literal-IP hosts skip DNS entirely and
 * are gated by `assertSafeWebhookUrl`'s pre-flight check instead.
 */
export function safeLookup(
  hostname: string,
  options: { all?: boolean; family?: number | "IPv4" | "IPv6" },
  callback: LookupCallback,
): void {
  lookup(hostname, { all: true })
    .then((records) => {
      const fam = options?.family;
      const familyNum =
        fam === 4 || fam === "IPv4" ? 4 : fam === 6 || fam === "IPv6" ? 6 : 0;
      const matching = familyNum
        ? records.filter((r) => r.family === familyNum)
        : records;
      if (matching.length === 0) {
        callback(new UnsafeUrlError(`${hostname} did not resolve`), "", 0);
        return;
      }
      // Validate every resolved address, not just the one we return, so a
      // multi-record response can't smuggle a private IP past us.
      if (!allowPrivateWebhooks()) {
        for (const r of matching) {
          if (isPrivateAddress(r.address)) {
            callback(
              new UnsafeUrlError(
                `${hostname} resolves to private address ${r.address}`,
              ),
              "",
              0,
            );
            return;
          }
        }
      }
      if (options?.all) {
        callback(null, matching);
      } else {
        const first = matching[0]!;
        callback(null, first.address, first.family);
      }
    })
    .catch((err: NodeJS.ErrnoException) => callback(err, "", 0));
}
