import { and, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { walletRegistrations } from "@/db/schema";
import { log } from "@/lib/log";
import { pushPassUpdate } from "./apns";

/**
 * Pushes a pass-update notification to every device registered for the
 * given key. Wallet receives an empty push and re-fetches the pass from
 * /api/wallet/v1/passes/:passTypeId/:serial.
 *
 * Best-effort. Per-device errors are logged; APNs 410 (Unregistered)
 * triggers local cleanup so we stop trying to push to dead tokens.
 *
 * Returns the number of pushes successfully delivered to APNs (not to the
 * device — APNs doesn't tell us about device-side outcomes). Returns null
 * when APNs is not configured.
 */
export async function notifyPassUpdate(keyId: string): Promise<number | null> {
  const regs = await db
    .select()
    .from(walletRegistrations)
    .where(eq(walletRegistrations.keyId, keyId));

  if (regs.length === 0) return 0;

  const tokens = regs.map((r) => r.pushToken);
  const results = await pushPassUpdate(tokens);
  if (results === null) {
    log.debug(
      { keyId, registrations: regs.length },
      "APNs not configured; skipping pass-update push",
    );
    return null;
  }

  let ok = 0;
  for (const r of results) {
    if (r.ok) {
      ok++;
      continue;
    }
    if (r.status === 410) {
      // BadDeviceToken / Unregistered — delete the registration so we don't
      // keep retrying. Apple returns the timestamp the token went bad; we
      // don't need it, we just stop using it.
      const reg = regs.find((x) => x.pushToken === r.pushToken);
      if (reg) {
        await db
          .delete(walletRegistrations)
          .where(
            and(
              eq(walletRegistrations.keyId, keyId),
              eq(walletRegistrations.pushToken, r.pushToken),
            ),
          );
        log.info({ keyId, pushToken: r.pushToken.slice(0, 8) }, "removed expired APNs registration");
      }
    } else {
      log.warn(
        { keyId, pushToken: r.pushToken.slice(0, 8), status: r.status, error: r.error },
        "APNs push failed",
      );
    }
  }
  return ok;
}
