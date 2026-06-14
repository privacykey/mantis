import { type NextRequest, NextResponse } from "next/server";
import { requireApiKeyOrSession } from "@/lib/auth";
import { clearCaptures, isEnabled, listCaptures } from "@/lib/inbox";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  if (!isEnabled()) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  // The capture buffer holds arbitrary request headers + bodies the operator
  // routed to /inbox. Reading it requires operator auth (API key or session)
  // even though the capture endpoint itself is unauthenticated by design.
  const auth = await requireApiKeyOrSession(req);
  if (!auth.ok) return auth.res;

  const slug = req.nextUrl.searchParams.get("slug") ?? undefined;
  const since = Number(req.nextUrl.searchParams.get("since") ?? "0");
  const all = listCaptures(slug);
  const data = since > 0 ? all.filter((c) => c.id > since) : all;
  return NextResponse.json({ data, latest_id: all[0]?.id ?? 0 });
}

export async function DELETE(req: NextRequest) {
  if (!isEnabled()) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const auth = await requireApiKeyOrSession(req);
  if (!auth.ok) return auth.res;

  clearCaptures();
  return new NextResponse(null, { status: 204 });
}
