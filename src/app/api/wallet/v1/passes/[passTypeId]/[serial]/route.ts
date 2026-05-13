import { type NextRequest, NextResponse } from "next/server";
import { generateApplePass } from "@/lib/installers/apple-wallet";
import { keyUrl } from "@/lib/env";
import {
  authenticateWalletRequest,
  recordWalletHit,
} from "@/lib/installers/wallet-hit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Ctx = {
  params: Promise<{ passTypeId: string; serial: string }>;
};

/**
 * Wallet fetches the latest version of a pass from this endpoint. Happens
 * when it thinks the pass has been updated (we don't push updates, but it
 * can be a manual refresh too).
 */
export async function GET(req: NextRequest, ctx: Ctx) {
  const { passTypeId, serial } = await ctx.params;
  const auth = await authenticateWalletRequest(req, passTypeId, serial);
  if (!auth.ok) return new NextResponse(null, { status: auth.status });

  await recordWalletHit(req, auth.key, "wallet-fetched");

  const buf = await generateApplePass({
    publicId: auth.key.publicId,
    keyId: auth.key.id,
    memo: auth.key.memo,
    triggerUrl: keyUrl(auth.key.publicId),
  });
  return new NextResponse(new Uint8Array(buf), {
    status: 200,
    headers: {
      "Content-Type": "application/vnd.apple.pkpass",
      "Cache-Control": "no-store",
    },
  });
}
