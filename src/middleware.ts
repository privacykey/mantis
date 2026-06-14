import type { NextRequest } from "next/server";
import { proxy } from "@/proxy";

// Next.js only auto-runs edge middleware from this magic filename. Without it,
// the host-based public/dashboard split (PUBLIC_ONLY_HOSTS / DASHBOARD_HOSTS)
// implemented in proxy.ts is dead code and the split is never enforced. This
// thin wrapper wires it into the request path; proxy.ts stays the unit-testable
// gate. When neither host list is configured the gate is a pass-through, so
// single-host deployments are unaffected.
export function middleware(req: NextRequest) {
  return proxy(req);
}

export const config = {
  // Run on everything except Next internals and the favicon; the gate itself
  // decides, per host + path, whether to allow or 404. API routes MUST be
  // included so the management surface is gated on public-only hosts.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
