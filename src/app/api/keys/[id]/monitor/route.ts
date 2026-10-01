import { type NextRequest, NextResponse } from "next/server";
import { loadOwnedKey, requireApiKeyOrSession } from "@/lib/auth";
import { computeMonitorState } from "@/lib/monitor";
import { log } from "@/lib/log";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const headers = { "Cache-Control": "no-store" };

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireApiKeyOrSession(req);
  if (!auth.ok) return auth.res;
  const { id } = await ctx.params;
  try {
    const key = await loadOwnedKey(auth.key, id);
    if (!key) return NextResponse.json({ error: "not_found" }, { status: 404, headers });
    const state = await computeMonitorState(key);
    return NextResponse.json({
      state: state.kind,
      tripped_at: state.kind === "tripped" ? state.trippedAt.toISOString() : null,
      mode: key.monitorMode,
      window_seconds: key.monitorWindowSeconds,
    }, { headers });
  } catch (err) {
    log.error({ err, keyId: id }, "monitor state unavailable");
    return NextResponse.json({ error: "unavailable" }, { status: 503, headers });
  }
}
