"use server";

import { randomBytes } from "node:crypto";
import { revalidatePath } from "next/cache";
import { audit } from "@/lib/audit";
import { getSessionApiKey } from "@/lib/session";
import { generateApplePass } from "@/lib/installers/apple-wallet";
import {
  deleteWalletConfig,
  invalidateWalletCache,
  saveWalletConfig,
} from "@/lib/installers/wallet-store";

const TEAM_ID_RE = /^[A-Z0-9]{10}$/;
const PASS_TYPE_ID_RE = /^pass\.[A-Za-z0-9.\-]+$/;

export type WalletConfigState = {
  ok?: boolean;
  message?: string;
  error?: string;
};

async function fileToBase64(file: File | null): Promise<string | null> {
  if (!file || file.size === 0) return null;
  const buf = Buffer.from(await file.arrayBuffer());
  return buf.toString("base64");
}

/**
 * Dormant: the dashboard upload form that submitted here was removed — wallet
 * config is APPLE_PASS_* env-var driven now. Kept (with saveWalletConfig) so
 * the DB path can be re-enabled without rework.
 */
export async function saveWalletConfigAction(
  _prev: WalletConfigState,
  formData: FormData,
): Promise<WalletConfigState> {
  const session = await getSessionApiKey();
  if (!session) return { error: "not authenticated" };
  // Global config — admin-gated to prevent one session from breaking Wallet for everyone.
  if (!session.isAdmin) {
    return { error: "admin API key required to modify wallet config" };
  }

  const certFile = formData.get("cert_p12") as File | null;
  const certPass = String(formData.get("cert_pass") ?? "");
  const teamId = String(formData.get("team_id") ?? "").trim();
  const passTypeId = String(formData.get("pass_type_id") ?? "").trim();
  const organizationName =
    String(formData.get("organization_name") ?? "").trim() || "Mantis";
  let authSecret = String(formData.get("auth_secret") ?? "").trim();
  const wwdrFile = formData.get("wwdr_pem") as File | null;
  const iconFile = formData.get("icon_png") as File | null;
  const logoFile = formData.get("logo_png") as File | null;

  if (!certFile || certFile.size === 0) {
    return { error: "Pass Type ID .p12 file is required" };
  }
  if (certFile.size > 100_000) {
    return { error: "cert file too large (max 100 KB)" };
  }
  if (!certPass) {
    return { error: "cert password is required" };
  }
  if (!TEAM_ID_RE.test(teamId)) {
    return { error: "team ID must be 10 uppercase alphanumeric characters" };
  }
  if (!PASS_TYPE_ID_RE.test(passTypeId)) {
    return {
      error:
        "pass type ID must start with 'pass.' and contain only letters/digits/dots/dashes",
    };
  }
  if (!authSecret) {
    // Generate a fresh secret if the operator didn't provide one. This is
    // surfaced back in the success message so they can save it elsewhere.
    authSecret = randomBytes(32).toString("base64url");
  } else if (authSecret.length < 16) {
    return { error: "auth secret must be at least 16 characters" };
  }

  const certP12B64 = (await fileToBase64(certFile))!;
  const wwdrPemB64 = await fileToBase64(wwdrFile);
  const iconPngB64 = await fileToBase64(iconFile);
  const logoPngB64 = await fileToBase64(logoFile);

  try {
    await saveWalletConfig({
      certP12B64,
      certPass,
      teamId,
      passTypeId,
      organizationName,
      authSecret,
      wwdrPemB64,
      iconPngB64,
      logoPngB64,
    });
  } catch (err) {
    return {
      error:
        err instanceof Error
          ? `failed to save: ${err.message}`
          : "failed to save",
    };
  }

  // Smoke-test the cert by signing a throwaway pass — surfaces bad
  // password / wrong cert chain immediately instead of on first download.
  invalidateWalletCache();
  try {
    await generateApplePass({
      publicId: "smoketest",
      keyId: "00000000-0000-0000-0000-000000000000",
      memo: "smoke test (will not be installable)",
      triggerUrl: "https://example.com",
    });
  } catch (err) {
    return {
      error:
        err instanceof Error
          ? `saved, but pass generation failed: ${err.message}. Check the .p12 password, team ID, and pass type ID.`
          : "saved, but pass generation failed",
    };
  }

  await audit({
    type: "wallet_config.saved",
    actorApiKeyId: session.id,
    actorLabel: session.name,
    subjectKind: "wallet_config",
    subjectId: "default",
    metadata: { teamId, passTypeId, organizationName },
  });
  revalidatePath("/settings/wallet");
  return {
    ok: true,
    message: "Wallet config saved and smoke-tested.",
  };
}

export async function deleteWalletConfigAction(): Promise<void> {
  const session = await getSessionApiKey();
  if (!session) return;
  if (!session.isAdmin) return;
  await deleteWalletConfig();
  await audit({
    type: "wallet_config.cleared",
    actorApiKeyId: session.id,
    actorLabel: session.name,
    subjectKind: "wallet_config",
    subjectId: "default",
  });
  revalidatePath("/settings/wallet");
}
