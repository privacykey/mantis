import { lookup } from "node:dns/promises";
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
  const [a = 0, b = 0] = parts;
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // RFC1918
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local + AWS/GCP/Azure metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 0) return true; // 192.0.0.0/24 IETF protocol assignments
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 100 && b >= 64 && b <= 127) return true; // RFC6598 CGNAT
  if (a >= 224) return true; // multicast + reserved
  return false;
}

function isPrivateV6(addr: string): boolean {
  const lower = addr.toLowerCase().replace(/%.*$/, ""); // strip zone id
  if (lower === "::" || lower === "::1") return true;
  if (lower.startsWith("fe80:") || lower.startsWith("fe80::")) return true; // link-local
  if (/^f[cd][0-9a-f]{2}:/.test(lower)) return true; // ULA fc00::/7
  if (lower.startsWith("ff")) return true; // multicast
  // IPv4-mapped (::ffff:a.b.c.d) — check inner v4
  const v4Match = lower.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (v4Match?.[1]) return isPrivateV4(v4Match[1]);
  return false;
}

export class UnsafeUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeUrlError";
  }
}

export function allowPrivateWebhooks(): boolean {
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
