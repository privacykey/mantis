import { NextResponse, type NextRequest } from "next/server";
import { publicOnlyDecision } from "@/lib/public-only-hosts";

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

  if (decision.allowed) return NextResponse.next();

  return new NextResponse(null, {
    status: 404,
    headers: {
      "Cache-Control": "no-store",
    },
  });
}
