import { eq } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";
import { db } from "@/db/client";
import { keys } from "@/db/schema";
import { audit } from "@/lib/audit";
import { loadOwnedKey, requireApiKeyOrSession } from "@/lib/auth";
import { computeMonitorState } from "@/lib/monitor";
import { serializeKey } from "@/lib/keys";
import { extractIp } from "@/lib/request-info";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, ctx: Ctx) {
  const auth = await requireApiKeyOrSession(req);
  if (!auth.ok) return auth.res;

  const { id } = await ctx.params;
  const existing = await loadOwnedKey(auth.key, id);
  if (!existing) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const [updated] = await db
    .update(keys)
    .set({ monitorResetAt: new Date() })
    .where(eq(keys.id, id))
    .returning();

  if (!updated) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  // Clearing a tripped monitor is recorded like the dashboard's reset action.
  await audit({
    type: "monitor.reset",
    actorApiKeyId: auth.key.id,
    actorLabel: auth.key.name,
    subjectKind: "key",
    subjectId: id,
    metadata: { via: "api" },
    ip: extractIp(req),
  });

  const state = await computeMonitorState(updated);
  return NextResponse.json({
    ...serializeKey(updated),
    monitor_state: state.kind,
    monitor_tripped_at:
      state.kind === "tripped" ? state.trippedAt.toISOString() : null,
  });
}
