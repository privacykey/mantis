import { type NextRequest, NextResponse } from "next/server";
import { loadActiveWalletConfig } from "@/lib/installers/wallet-store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Ctx = {
  params: Promise<{ deviceId: string; passTypeId: string }>;
};

/**
 * Wallet's daily "updated passes since last check" poll. We never push
 * updates from the server, so always 204. No hit is recorded — these polls
 * are routine traffic, not a meaningful "still installed" signal.
 */
export async function GET(_req: NextRequest, ctx: Ctx) {
  const { passTypeId } = await ctx.params;
  const cfg = await loadActiveWalletConfig();
  if (!cfg) return new NextResponse(null, { status: 503 });
  if (passTypeId !== cfg.passTypeId) {
    return new NextResponse(null, { status: 404 });
  }
  return new NextResponse(null, { status: 204 });
}
