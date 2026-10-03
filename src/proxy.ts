import { NextResponse, type NextRequest } from "next/server";
import { publicOnlyDecision } from "@/lib/public-only-hosts";
import { publicPathRewrite } from "@/lib/public-path";
import { statusPublicId } from "@/lib/status-tag";

// Next.js auto-runs this `proxy` entrypoint (formerly `middleware.ts`, renamed
// in Next 16 — having both files is a build error) on matching requests. It
// enforces the host-based public/dashboard split (PUBLIC_ONLY_HOSTS /
// DASHBOARD_HOSTS); when neither host list is configured the gate is a
// pass-through, so single-host deployments are unaffected. Kept unit-testable:
// see tests/proxy.test.ts.
export function proxy(req: NextRequest) {
  const decision = publicOnlyDecision({
    host: req.headers.get("host") ?? req.nextUrl.host,
    pathname: req.nextUrl.pathname,
    configuredHosts: process.env.PUBLIC_ONLY_HOSTS,
    configuredDashboardHosts: process.env.DASHBOARD_HOSTS,
    publicPath: process.env.MANTIS_PUBLIC_PATH,
    allowHealth: process.env.PUBLIC_ONLY_ALLOW_HEALTH === "1",
    allowInbox: process.env.PUBLIC_ONLY_ALLOW_INBOX === "1",
  });

  if (!decision.allowed) return notFound();

  // A status URL is a capability: /status/<publicId>.<tag> (lib/status-tag.ts).
  // Without a valid tag it gets the same answer as a blocked path, here,
  // before any route handler runs, so the fixed /status path says nothing
  // about the service or about which keys exist.
  if (
    req.nextUrl.pathname.startsWith(STATUS_PREFIX) &&
    statusPublicId(
      req.nextUrl.pathname.slice(STATUS_PREFIX.length).replace(/\/$/, ""),
    ) === null
  ) {
    return notFound();
  }

  // Custom trigger prefix (MANTIS_PUBLIC_PATH) → the real /c/[publicId] route,
  // keeping any path a tool appended to the bait URL. Also drops a trailing
  // slash on trigger URLs so they reach the handler rather than a redirect.
  const pathname = req.nextUrl.pathname;
  const rewrite = publicPathRewrite(pathname, process.env.MANTIS_PUBLIC_PATH);
  if (rewrite) {
    // A plain URL, not req.nextUrl.clone(): NextURL remembers that the request
    // path ended in a slash and would put it back on the rewritten path.
    return NextResponse.rewrite(
      new URL(`${rewrite}${req.nextUrl.search}`, req.nextUrl.origin),
    );
  }

  // next.config.ts sets skipTrailingSlashRedirect so the trigger URLs above are
  // not 308'd before this proxy sees them. Reproduce Next's default
  // `/path/` → `/path` permanent redirect for everything else.
  const redirect = trailingSlashRedirect(pathname, req.nextUrl.search);
  if (redirect) {
    // The runtime needs an absolute Location from a proxy and, because it is
    // on the request's own host, sends it to the client path-relative (as
    // Next's own redirect is) — so it stays on the origin the browser used.
    return NextResponse.redirect(new URL(redirect, req.nextUrl.origin), 308);
  }

  return NextResponse.next();
}

const STATUS_PREFIX = "/status/";

function notFound(): NextResponse {
  return new NextResponse(null, {
    status: 404,
    headers: {
      "Cache-Control": "no-store",
    },
  });
}

// `/path/` → `/path` (+ query), or null when there is nothing to strip. A path
// that would resolve as scheme-relative (`//host`, `/\host`) — i.e. off this
// origin — is never turned into a redirect target.
function trailingSlashRedirect(pathname: string, search: string): string | null {
  if (pathname.length < 2 || !pathname.endsWith("/")) return null;
  const stripped = pathname.replace(/\/+$/, "");
  if (!/^\/[^/\\]/.test(stripped) || stripped.includes("\\")) return null;
  return `${stripped}${search}`;
}

export const config = {
  // Run on everything except Next internals and the favicon; the gate itself
  // decides, per host + path, whether to allow or 404. API routes MUST be
  // included so the management surface is gated on public-only hosts.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
