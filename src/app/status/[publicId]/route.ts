import { eq } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";
import { db } from "@/db/client";
import { keys, type Key } from "@/db/schema";
import { log } from "@/lib/log";
import { computeMonitorState } from "@/lib/monitor";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Ctx = { params: Promise<{ publicId: string }> };

const SAFE_ID_RE = /^[A-Za-z0-9]{6,32}$/;

const NO_STORE_HEADERS = {
  "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
  Pragma: "no-cache",
};

async function lookupKey(publicId: string): Promise<Key | null> {
  if (!SAFE_ID_RE.test(publicId)) return null;
  const [row] = await db
    .select()
    .from(keys)
    .where(eq(keys.publicId, publicId))
    .limit(1);
  return row ?? null;
}

function notMonitored(): Response {
  return NextResponse.json(
    { error: "not_monitored" },
    { status: 404, headers: NO_STORE_HEADERS },
  );
}

async function handle(publicId: string): Promise<Response> {
  let key: Key | null = null;
  try {
    key = await lookupKey(publicId);
  } catch (err) {
    log.error({ err, publicId }, "status lookup failed");
  }

  if (!key) return notMonitored();

  const state = await computeMonitorState(key);
  if (state.kind === "off") return notMonitored();

  if (state.kind === "tripped") {
    return NextResponse.json(
      {
        status: "tripped",
        tripped_at: state.trippedAt.toISOString(),
        mode: key.monitorMode,
      },
      { status: 503, headers: NO_STORE_HEADERS },
    );
  }

  return NextResponse.json(
    { status: "ok", mode: key.monitorMode },
    { status: 200, headers: NO_STORE_HEADERS },
  );
}

export async function GET(_req: NextRequest, ctx: Ctx) {
  const { publicId } = await ctx.params;
  return handle(publicId);
}

export async function HEAD(_req: NextRequest, ctx: Ctx) {
  const { publicId } = await ctx.params;
  return handle(publicId);
}
