import { eq } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";
import { db } from "@/db/client";
import { keys, type Key } from "@/db/schema";
import { statusPublicId } from "@/lib/env";
import { log } from "@/lib/log";
import { computeMonitorState } from "@/lib/monitor";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// The path segment is `<publicId>.<tag>` (see statusUrl()). The public id alone
// is the bait — it is in every trigger URL — so it must not read the monitor.
type Ctx = { params: Promise<{ publicId: string }> };

const NO_STORE_HEADERS = {
  "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
  Pragma: "no-cache",
};

async function lookupKey(publicId: string): Promise<Key | null> {
  const [row] = await db
    .select()
    .from(keys)
    .where(eq(keys.publicId, publicId))
    .limit(1);
  return row ?? null;
}

// The same body-less response src/proxy.ts builds for a blocked path, for
// every "nothing to read here" case (no/invalid tag, unknown key, monitor
// off), so this route neither names the service nor confirms that a key
// exists. (Next still adds its app-router `Vary` header to anything a route
// handler returns; only a check in the proxy itself could avoid that.)
function notFound(): Response {
  return new NextResponse(null, {
    status: 404,
    headers: { "Cache-Control": "no-store" },
  });
}

async function handle(token: string): Promise<Response> {
  const publicId = statusPublicId(token);
  if (!publicId) return notFound();
  try {
    const key = await lookupKey(publicId);
    if (!key) return notFound();
    const state = await computeMonitorState(key);
    if (state.kind === "off") return notFound();
    // The status code is all Uptime Kuma needs. When and how the key tripped
    // stays behind the owner-gated /api/keys/:id/monitor.
    return NextResponse.json(
      { status: state.kind },
      { status: state.kind === "tripped" ? 503 : 200, headers: NO_STORE_HEADERS },
    );
  } catch (err) {
    log.error({ err, publicId }, "monitor status unavailable");
    return NextResponse.json({ error: "unavailable" }, { status: 503, headers: NO_STORE_HEADERS });
  }
}

export async function GET(_req: NextRequest, ctx: Ctx) {
  const { publicId } = await ctx.params;
  return handle(publicId);
}

export async function HEAD(_req: NextRequest, ctx: Ctx) {
  const { publicId } = await ctx.params;
  return handle(publicId);
}
