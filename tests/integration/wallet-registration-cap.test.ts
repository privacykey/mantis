import { describe, it, expect, vi } from "vitest";

// E2E-02 — Apple Wallet per-key device-registration cap (commit 5573c92c).
// A .pkpass embeds a long-lived auth token held by every recipient; without a
// cap one holder could register unbounded attacker-chosen deviceIds. The soft
// cap drops the 51st NEW device but still returns 201 (no cap leak), while an
// existing device refreshes without counting against the cap.

vi.mock("@/lib/log", () => ({
  log: { info() {}, warn() {}, error() {}, debug() {}, fatal() {}, trace() {} },
}));

import { POST as registerDevice } from "@/app/api/wallet/v1/devices/[deviceId]/registrations/[passTypeId]/[serial]/route";
import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { walletConfig, walletRegistrations } from "@/db/schema";
import { deriveAuthToken } from "@/lib/installers/apple-wallet";
import { invalidateWalletCache } from "@/lib/installers/wallet-store";
import { seedApiKey, seedCanaryKey, ctxParams } from "./_harness";

const PASS_TYPE = "pass.com.mantis.test";
const SERIAL = "walletserial1";
const AUTH_SECRET = "abcdefghijklmnopqrstuvwxyz012345"; // 32 chars

async function seedWallet(): Promise<{ keyId: string; token: string }> {
  await db.insert(walletConfig).values({
    certP12B64: Buffer.from("not-a-real-cert").toString("base64"),
    certPass: "passphrase",
    teamId: "ABCDE12345",
    passTypeId: PASS_TYPE,
    authSecret: AUTH_SECRET,
  });
  invalidateWalletCache();
  const owner = await seedApiKey();
  const key = await seedCanaryKey(owner.row.id, { publicId: SERIAL, memo: "wallet" });
  return { keyId: key.id, token: deriveAuthToken(key.id, AUTH_SECRET) };
}

function regReq(deviceId: string, token: string, pushToken: string): NextRequest {
  return new NextRequest(
    new URL(
      `http://localhost:3000/api/wallet/v1/devices/${deviceId}/registrations/${PASS_TYPE}/${SERIAL}`,
    ),
    {
      method: "POST",
      headers: new Headers({
        authorization: `ApplePass ${token}`,
        "content-type": "application/json",
      }),
      body: JSON.stringify({ pushToken }),
    },
  );
}

function regCount(keyId: string): Promise<{ length: number }> {
  return db
    .select()
    .from(walletRegistrations)
    .where(eq(walletRegistrations.keyId, keyId));
}

describe("E2E-02 wallet registration cap", () => {
  it("drops the 51st new device but still returns 201, and refreshes existing devices", async () => {
    const { keyId, token } = await seedWallet();
    const push = "a".repeat(64);

    for (let i = 0; i < 50; i++) {
      const res = await registerDevice(
        regReq(`dev-${i}`, token, push),
        ctxParams({ deviceId: `dev-${i}`, passTypeId: PASS_TYPE, serial: SERIAL }),
      );
      expect(res.status).toBe(201);
    }
    expect((await regCount(keyId)).length).toBe(50);

    // 51st NEW device: still 201 (no cap leak), but no new row.
    const overflow = await registerDevice(
      regReq("dev-50", token, push),
      ctxParams({ deviceId: "dev-50", passTypeId: PASS_TYPE, serial: SERIAL }),
    );
    expect(overflow.status).toBe(201);
    expect((await regCount(keyId)).length).toBe(50);

    // Existing device refresh: bypasses the cap, updates push token, count holds.
    const refresh = await registerDevice(
      regReq("dev-0", token, "b".repeat(64)),
      ctxParams({ deviceId: "dev-0", passTypeId: PASS_TYPE, serial: SERIAL }),
    );
    expect(refresh.status).toBe(201);
    expect((await regCount(keyId)).length).toBe(50);
    const [dev0] = await db
      .select()
      .from(walletRegistrations)
      .where(eq(walletRegistrations.deviceId, "dev-0"))
      .limit(1);
    expect(dev0!.pushToken).toBe("b".repeat(64));
  });

  it("rejects a bad ApplePass token with 401 and writes no row", async () => {
    const { keyId } = await seedWallet();
    const bad = await registerDevice(
      regReq("dev-x", "wrong-token-value", "c".repeat(64)),
      ctxParams({ deviceId: "dev-x", passTypeId: PASS_TYPE, serial: SERIAL }),
    );
    expect(bad.status).toBe(401);
    expect((await regCount(keyId)).length).toBe(0);
  });
});
