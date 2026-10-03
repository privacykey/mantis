import { env } from "@/lib/env";
import { normalizeHost } from "@/lib/public-only-hosts";

// A webhook-shaped destination that points back at this instance turns every
// delivery (and the activation ping) into a request to our own routes. Aimed
// at a trigger URL it is recorded as a fresh hit, which fans out again. The
// trigger route cannot tell such a request apart by its markers — User-Agent
// and X-Mantis-* headers are anonymous-controlled, and honouring them would
// let anyone who trips a canary silence it — so the destination is refused
// instead, when it is saved and again when it is sent.

export const SELF_DESTINATION = "destination must not point at this Mantis instance";

const LOOPBACK = "localhost";

function canonicalHost(value: string | null | undefined): string | null {
  const host = normalizeHost(value);
  if (!host) return null;
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    /^127(?:\.\d{1,3}){3}$/.test(host) ||
    host === "0.0.0.0" ||
    host === "::1" ||
    host === "::" ||
    /^::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}$/.test(host)
  ) {
    return LOOPBACK;
  }
  return host;
}

function effectivePort(u: URL): string {
  return u.port || (u.protocol === "https:" ? "443" : "80");
}

/** host → ports on which that name reaches this instance. */
function ownEndpoints(): Map<string, Set<string>> {
  const endpoints = new Map<string, Set<string>>();
  const add = (host: string | null, ports: Iterable<string>) => {
    if (!host) return;
    const set = endpoints.get(host) ?? new Set<string>();
    for (const port of ports) set.add(port);
    endpoints.set(host, set);
  };

  const basePorts = new Set<string>();
  for (const base of [env.publicBaseUrl, env.dashboardBaseUrl]) {
    let u: URL;
    try {
      u = new URL(base);
    } catch {
      continue;
    }
    const port = effectivePort(u);
    // One front end normally answers both default ports (http → https).
    const ports = port === "80" || port === "443" ? ["80", "443"] : [port];
    for (const p of ports) basePorts.add(p);
    add(canonicalHost(u.hostname), ports);
  }

  // Host-split names carry no port; they reach the same listener as the base
  // URLs. A different port on the same name may be an unrelated service
  // (Home Assistant next to Mantis on one box), so only these ports count.
  for (const list of [process.env.PUBLIC_ONLY_HOSTS, process.env.DASHBOARD_HOSTS]) {
    for (const part of (list ?? "").split(/[\s,]+/)) {
      add(canonicalHost(part), basePorts);
    }
  }

  // Whatever the public names are, loopback on our own port is this process.
  add(LOOPBACK, [process.env.PORT || "3000"]);
  return endpoints;
}

/**
 * True when `target` is an http(s) URL served by this Mantis instance, judged
 * by host and port against PUBLIC_BASE_URL, DASHBOARD_BASE_URL and the
 * PUBLIC_ONLY_HOSTS / DASHBOARD_HOSTS lists. A name that merely routes back
 * here (a second tunnel hostname, a relay) is not detectable from the URL.
 */
export function isSelfTarget(target: string): boolean {
  let u: URL;
  try {
    u = new URL(target);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  const host = canonicalHost(u.hostname);
  if (!host) return false;
  if (!ownEndpoints().get(host)?.has(effectivePort(u))) return false;
  // The built-in dev inbox (/inbox/<slug>, ENABLE_DEV_INBOX=1) is a webhook
  // receiver on our own origin by design — the getting-started guide points a
  // first key at it. It only captures (404 when disabled) and never records a
  // hit, unless the trigger prefix itself has been moved under /inbox.
  const underTrigger =
    u.pathname === env.publicPath || u.pathname.startsWith(`${env.publicPath}/`);
  if (u.pathname.startsWith("/inbox/") && !underTrigger) return false;
  return true;
}
