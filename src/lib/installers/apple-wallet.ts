import { createHmac, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PKPass } from "passkit-generator";
import { walletWebServiceUrl } from "@/lib/env";
import { pngSolid } from "./png-solid";
import {
  loadActiveWalletConfig,
  type ResolvedWalletConfig,
} from "./wallet-store";

const MANTIS_YELLOW: [number, number, number] = [250, 204, 21]; // #facc15

// Apple's WWDR G3 intermediate cert, bundled at wallet-assets/wwdr.pem. Valid
// until 2030-02-20. Apple distributes it publicly at
// https://www.apple.com/certificateauthority/AppleWWDRCAG3.cer — included in
// the repo so .pkpass signing works out of the box without operator setup.
// Operators can override via APPLE_PASS_WWDR_PATH (env-var config) or by
// uploading a fresh PEM in Settings → Wallet (DB config).
let bundledWwdrCache: Buffer | null = null;
async function loadBundledWwdr(): Promise<Buffer> {
  if (bundledWwdrCache) return bundledWwdrCache;
  const here = dirname(fileURLToPath(import.meta.url));
  const path = join(here, "wallet-assets", "wwdr.pem");
  bundledWwdrCache = await readFile(path);
  return bundledWwdrCache;
}

export type ApplePassInput = {
  /** The mantis key's publicId — becomes pass.serialNumber. */
  publicId: string;
  /** The key UUID — used to derive the per-pass authenticationToken. */
  keyId: string;
  /** Memo, shown as the pass body field. */
  memo: string;
  /** URL of the trigger endpoint — embedded as a relevance link, also as the pass front. */
  triggerUrl: string;
};

/**
 * Generates a signed .pkpass bundle for the given mantis key. The pass calls
 * back to the mantis API (`/api/wallet/...`) when installed, removed, and
 * roughly daily as a heartbeat while installed — each of those becomes a hit
 * with X-Mantis-Source: wallet-{event}.
 *
 * Config comes from env vars first, then the wallet_config DB row.
 */
export async function generateApplePass(
  input: ApplePassInput,
): Promise<Buffer> {
  const cfg = await loadActiveWalletConfig();
  if (!cfg) {
    throw new ApplePassDisabledError();
  }

  const iconBuf = cfg.iconBuf ?? pngSolid(58, MANTIS_YELLOW);
  const iconAt2Buf = cfg.iconBuf ?? pngSolid(58, MANTIS_YELLOW);
  const iconAt3Buf = cfg.iconBuf ?? pngSolid(87, MANTIS_YELLOW);
  const logoBuf = cfg.logoBuf ?? pngSolid(160, MANTIS_YELLOW);

  const authToken = deriveAuthToken(input.keyId, cfg.authSecret);

  const passData = {
    formatVersion: 1,
    passTypeIdentifier: cfg.passTypeId,
    teamIdentifier: cfg.teamId,
    organizationName: cfg.organizationName,
    serialNumber: input.publicId,
    description: input.memo,
    webServiceURL: walletWebServiceUrl(),
    authenticationToken: authToken,
    foregroundColor: "rgb(0, 0, 0)",
    backgroundColor: "rgb(250, 204, 21)",
    labelColor: "rgb(60, 60, 60)",
    logoText: cfg.organizationName,
    storeCard: {
      primaryFields: [
        {
          key: "memo",
          label: "Memo",
          value: input.memo,
        },
      ],
      secondaryFields: [
        {
          key: "issued",
          label: "Issued",
          value: new Date().toISOString().slice(0, 10),
        },
      ],
    },
  };

  const wwdr = cfg.wwdrBuf ?? (await loadBundledWwdr());

  const pass = new PKPass(
    {} as never,
    {
      wwdr,
      signerCert: cfg.certBuf,
      signerKey: cfg.certBuf,
      signerKeyPassphrase: cfg.certPass,
    },
    passData as never,
  );

  pass.addBuffer("icon.png", iconBuf);
  pass.addBuffer("icon@2x.png", iconAt2Buf);
  pass.addBuffer("icon@3x.png", iconAt3Buf);
  pass.addBuffer("logo.png", logoBuf);
  pass.addBuffer("logo@2x.png", logoBuf);

  return pass.getAsBuffer();
}

export function deriveAuthToken(keyId: string, secret: string): string {
  return createHmac("sha256", secret)
    .update(keyId)
    .digest("base64url")
    .slice(0, 32);
}

export function verifyAuthToken(
  keyId: string,
  secret: string,
  presented: string,
): boolean {
  const expected = deriveAuthToken(keyId, secret);
  if (presented.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(presented), Buffer.from(expected));
  } catch {
    return false;
  }
}

export async function isApplePassEnabled(): Promise<boolean> {
  const cfg = await loadActiveWalletConfig();
  return cfg !== null;
}

export async function applePassConfig(): Promise<ResolvedWalletConfig | null> {
  return loadActiveWalletConfig();
}

export class ApplePassDisabledError extends Error {
  constructor() {
    super(
      "Apple Wallet integration is not configured. Either set the APPLE_PASS_* env vars or upload a Pass Type ID .p12 in Settings → Wallet.",
    );
    this.name = "ApplePassDisabledError";
  }
}
