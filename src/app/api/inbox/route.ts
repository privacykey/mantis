import { type NextRequest, NextResponse } from "next/server";
import { clearCaptures, isEnabled, listCaptures } from "@/lib/inbox";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  if (!isEnabled()) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const slug = req.nextUrl.searchParams.get("slug") ?? undefined;
  const since = Number(req.nextUrl.searchParams.get("since") ?? "0");
  const all = listCaptures(slug);
  const data = since > 0 ? all.filter((c) => c.id > since) : all;
  return NextResponse.json({ data, latest_id: all[0]?.id ?? 0 });
}

export async function DELETE() {
  if (!isEnabled()) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  clearCaptures();
  return new NextResponse(null, { status: 204 });
}
