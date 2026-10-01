import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { clearSessionCookie } from "@/lib/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// POST-only — a GET would let `<img src=/logout>` end sessions cross-origin.
export async function POST(_req: NextRequest): Promise<Response> {
  await clearSessionCookie();
  // The request URL can carry the standalone server's internal host behind a
  // proxy. A relative redirect keeps the browser on its current dashboard
  // origin, including when the public trigger host is different.
  return new NextResponse(null, { status: 303, headers: { Location: "/login" } });
}
