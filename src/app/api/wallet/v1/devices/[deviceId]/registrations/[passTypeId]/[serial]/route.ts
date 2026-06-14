import { and, eq } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";
import { db } from "@/db/client";
import { walletRegistrations } from "@/db/schema";
import { log } from "@/lib/log";
import {
  authenticateWalletRequest,
  recordWalletHit,
} from "@/lib/installers/wallet-hit";
import { readBodyText } from "@/lib/safe-body";

// A push token is short base16; anything larger is abuse. Cap the read so a
// hostile (authenticated) device can't stream a multi-GB body into V8.
const MAX_REGISTRATION_BODY_BYTES = 8 * 1024;

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Ctx = {
  params: Promise<{
    deviceId: string;
    passTypeId: string;
    serial: string;
  }>;
};

// POST = device registers for updates on this pass (i.e. pass was installed).
// Body: `{ "pushToken": "<base16 string>" }`. Persisted so we can push
// updates when the key's memo (or anything pass-affecting) changes.
export async function POST(req: NextRequest, ctx: Ctx) {
  const { deviceId, passTypeId, serial } = await ctx.params;
  const auth = await authenticateWalletRequest(req, passTypeId, serial);
  if (!auth.ok) return new NextResponse(null, { status: auth.status });

  let pushToken: string | null = null;
  try {
    const raw = await readBodyText(req, MAX_REGISTRATION_BODY_BYTES);
    const body = (raw ? JSON.parse(raw) : null) as
      | { pushToken?: unknown }
      | null;
    if (body && typeof body.pushToken === "string" && /^[a-fA-F0-9]+$/.test(body.pushToken)) {
      pushToken = body.pushToken;
    }
  } catch {
    /* ignore — oversized/invalid body or no push token still records the install hit */
  }

  if (pushToken) {
    try {
      await db
        .insert(walletRegistrations)
        .values({
          deviceId,
          pushToken,
          keyId: auth.key.id,
          passTypeId,
        })
        .onConflictDoUpdate({
          target: [walletRegistrations.deviceId, walletRegistrations.keyId],
          set: { pushToken, updatedAt: new Date() },
        });
    } catch (err) {
      log.warn({ err, deviceId, keyId: auth.key.id }, "wallet registration upsert failed");
    }
  }

  await recordWalletHit(req, auth.key, "wallet-installed");
  return new NextResponse(null, { status: 201 });
}

// DELETE = device unregisters (pass was removed from Wallet).
export async function DELETE(req: NextRequest, ctx: Ctx) {
  const { deviceId, passTypeId, serial } = await ctx.params;
  const auth = await authenticateWalletRequest(req, passTypeId, serial);
  if (!auth.ok) return new NextResponse(null, { status: auth.status });

  await db
    .delete(walletRegistrations)
    .where(
      and(
        eq(walletRegistrations.deviceId, deviceId),
        eq(walletRegistrations.keyId, auth.key.id),
      ),
    );

  await recordWalletHit(req, auth.key, "wallet-uninstalled");
  return new NextResponse(null, { status: 200 });
}
