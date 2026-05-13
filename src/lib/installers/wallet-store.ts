import { readFile } from "node:fs/promises";
import { db } from "@/db/client";
import { walletConfig, type NewWalletConfig } from "@/db/schema";
import { env, type ApplePassConfig } from "@/lib/env";
import { log } from "@/lib/log";

/**
 * "Where did this config come from?" — useful for the dashboard to explain
 * to operators why their DB-stored cert is being ignored (env vars override).
 */
export type ConfigSource = "env" | "db" | null;

export type ResolvedWalletConfig = {
  source: Exclude<ConfigSource, null>;
  certBuf: Buffer;
  certPass: string;
  teamId: string;
  passTypeId: string;
  authSecret: string;
  organizationName: string;
  wwdrBuf: Buffer | null;
  iconBuf: Buffer | null;
  logoBuf: Buffer | null;
};

const CACHE_TTL_MS = 60_000;
let cached: { value: ResolvedWalletConfig | null; expiresAt: number } | null =
  null;

/**
 * Loads the active wallet config. Env vars take precedence; falls back to the
 * single `wallet_config` row in the DB. Cached for 60 seconds — call
 * `invalidateWalletCache()` after updating the DB row to flush.
 */
export async function loadActiveWalletConfig(): Promise<ResolvedWalletConfig | null> {
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const value = await doLoad();
  cached = { value, expiresAt: Date.now() + CACHE_TTL_MS };
  return value;
}

export function invalidateWalletCache(): void {
  cached = null;
}

async function doLoad(): Promise<ResolvedWalletConfig | null> {
  if (env.applePass) {
    try {
      return await loadFromEnv(env.applePass);
    } catch (err) {
      log.error(
        { err },
        "Apple Wallet env config present but assets failed to load; falling back to DB",
      );
    }
  }
  return loadFromDb();
}

async function loadFromEnv(
  cfg: ApplePassConfig,
): Promise<ResolvedWalletConfig> {
  const certBuf = await readFile(cfg.certPath);
  const wwdrBuf = cfg.wwdrPath ? await readFile(cfg.wwdrPath) : null;
  const iconBuf = cfg.iconPath ? await readFile(cfg.iconPath) : null;
  const logoBuf = cfg.logoPath ? await readFile(cfg.logoPath) : null;
  return {
    source: "env",
    certBuf,
    certPass: cfg.certPass,
    teamId: cfg.teamId,
    passTypeId: cfg.passTypeId,
    authSecret: cfg.authSecret,
    organizationName: cfg.organizationName,
    wwdrBuf,
    iconBuf,
    logoBuf,
  };
}

async function loadFromDb(): Promise<ResolvedWalletConfig | null> {
  const [row] = await db.select().from(walletConfig).limit(1);
  if (!row) return null;
  return {
    source: "db",
    certBuf: Buffer.from(row.certP12B64, "base64"),
    certPass: row.certPass,
    teamId: row.teamId,
    passTypeId: row.passTypeId,
    authSecret: row.authSecret,
    organizationName: row.organizationName,
    wwdrBuf: row.wwdrPemB64 ? Buffer.from(row.wwdrPemB64, "base64") : null,
    iconBuf: row.iconPngB64 ? Buffer.from(row.iconPngB64, "base64") : null,
    logoBuf: row.logoPngB64 ? Buffer.from(row.logoPngB64, "base64") : null,
  };
}

/**
 * Reports which (if any) config source is currently active. Used by the
 * dashboard to render the right state — env-locked / db-set / unset.
 */
export async function describeConfigSource(): Promise<{
  source: ConfigSource;
  envOverrides: boolean;
  dbConfigured: boolean;
  passTypeId: string | null;
  teamId: string | null;
  organizationName: string | null;
}> {
  const envOverrides = env.applePass !== null;
  const [dbRow] = await db.select().from(walletConfig).limit(1);
  const dbConfigured = !!dbRow;
  let source: ConfigSource = null;
  let passTypeId: string | null = null;
  let teamId: string | null = null;
  let organizationName: string | null = null;

  if (envOverrides) {
    source = "env";
    passTypeId = env.applePass!.passTypeId;
    teamId = env.applePass!.teamId;
    organizationName = env.applePass!.organizationName;
  } else if (dbConfigured) {
    source = "db";
    passTypeId = dbRow!.passTypeId;
    teamId = dbRow!.teamId;
    organizationName = dbRow!.organizationName;
  }
  return { source, envOverrides, dbConfigured, passTypeId, teamId, organizationName };
}

/**
 * Saves (upserts) the wallet config row. Called from the dashboard settings
 * page after a successful .p12 upload + form submit.
 */
export async function saveWalletConfig(
  input: Omit<NewWalletConfig, "id" | "createdAt" | "updatedAt">,
): Promise<void> {
  await db
    .insert(walletConfig)
    .values({ id: "default", ...input })
    .onConflictDoUpdate({
      target: walletConfig.id,
      set: {
        certP12B64: input.certP12B64,
        certPass: input.certPass,
        teamId: input.teamId,
        passTypeId: input.passTypeId,
        authSecret: input.authSecret,
        organizationName: input.organizationName ?? "Mantis",
        wwdrPemB64: input.wwdrPemB64 ?? null,
        iconPngB64: input.iconPngB64 ?? null,
        logoPngB64: input.logoPngB64 ?? null,
        updatedAt: new Date(),
      },
    });
  invalidateWalletCache();
}

export async function deleteWalletConfig(): Promise<void> {
  await db.delete(walletConfig);
  invalidateWalletCache();
}
