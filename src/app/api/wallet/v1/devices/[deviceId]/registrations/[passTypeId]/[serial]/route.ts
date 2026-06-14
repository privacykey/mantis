import { and, eq, sql } from "drizzle-orm";
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

// A pass's authenticationToken is long-lived and held by every recipient of the
// .pkpass. Without a cap, one holder could register unlimited attacker-chosen
// deviceIds for a key, bloating the table and amplifying APNs push fan-out on
// every hit. A real operator has a handful of devices; 50 is generous.
const MAX_REGISTRATIONS_PER_KEY = 50;

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
      // An existing (deviceId, keyId) pair just refreshes its push token. A NEW
      // device is subject to the per-key cap so a pass holder can't register an
      // unbounded number of attacker-chosen deviceIds.
      const [existing] = await db
        .select({ deviceId: walletRegistrations.deviceId })
        .from(walletRegistrations)
        .where(
          and(
            eq(walletRegistrations.deviceId, deviceId),
            eq(walletRegistrations.keyId, auth.key.id),
          ),
        )
        .limit(1);

      if (existing) {
        await db
          .update(walletRegistrations)
          .set({ pushToken, updatedAt: new Date() })
          .where(
            and(
              eq(walletRegistrations.deviceId, deviceId),
              eq(walletRegistrations.keyId, auth.key.id),
            ),
          );
      } else {
        const [row] = await db
          .select({ count: sql<number>`count(*)::int` })
          .from(walletRegistrations)
          .where(eq(walletRegistrations.keyId, auth.key.id));
        if ((row?.count ?? 0) < MAX_REGISTRATIONS_PER_KEY) {
          await db.insert(walletRegistrations).values({
            deviceId,
            pushToken,
            keyId: auth.key.id,
            passTypeId,
          });
        } else {
          // Soft cap (small TOCTOU race is acceptable for an abuse bound): drop
          // the new device but keep the PassKit 201 so we don't leak the cap.
          log.warn(
            { deviceId, keyId: auth.key.id, cap: MAX_REGISTRATIONS_PER_KEY },
            "wallet registration cap reached — skipping new device",
          );
        }
      }
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
