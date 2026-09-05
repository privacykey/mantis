import { NextResponse, type NextRequest } from "next/server";
import { publicOnlyDecision } from "@/lib/public-only-hosts";
import { publicPathRewrite } from "@/lib/public-path";

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

  if (!decision.allowed) {
    return new NextResponse(null, {
      status: 404,
      headers: {
        "Cache-Control": "no-store",
      },
    });
  }

  // Custom trigger prefix (MANTIS_PUBLIC_PATH) → the real /c/[publicId] route.
  const rewrite = publicPathRewrite(
    req.nextUrl.pathname,
    process.env.MANTIS_PUBLIC_PATH,
  );
  if (rewrite) {
    const url = req.nextUrl.clone();
    url.pathname = rewrite;
    return NextResponse.rewrite(url);
  }

  return NextResponse.next();
}

export const config = {
  // Run on everything except Next internals and the favicon; the gate itself
  // decides, per host + path, whether to allow or 404. API routes MUST be
  // included so the management surface is gated on public-only hosts.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
