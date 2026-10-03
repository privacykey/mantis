import { publicOnlyDecision } from "./public-only-hosts";
import { normalizePublicPath } from "./public-path";
import { statusTag } from "./status-tag";

export { statusPublicId, statusTag } from "./status-tag";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env: ${name}`);
  return v;
}

function optional(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

/**
 * Origin of the authenticated dashboard, for the links Mantis puts in alerts.
 * DASHBOARD_BASE_URL wins. Otherwise PUBLIC_BASE_URL is used — unless the host
 * split (PUBLIC_ONLY_HOSTS / DASHBOARD_HOSTS) makes that host public-only,
 * where /keys is a 404: then the first DASHBOARD_HOSTS entry is used, on
 * PUBLIC_BASE_URL's scheme and port unless the entry carries its own.
 */
export function resolveDashboardBaseUrl(input: {
  dashboardBaseUrl?: string | null;
  publicBaseUrl: string;
  publicOnlyHosts?: string | null;
  dashboardHosts?: string | null;
}): string {
  const explicit = input.dashboardBaseUrl?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");

  let publicUrl: URL;
  try {
    publicUrl = new URL(input.publicBaseUrl);
  } catch {
    return input.publicBaseUrl;
  }
  const decision = publicOnlyDecision({
    host: publicUrl.host,
    pathname: "/keys",
    configuredHosts: input.publicOnlyHosts,
    configuredDashboardHosts: input.dashboardHosts,
  });
  if (decision.allowed && !decision.publicOnly) return input.publicBaseUrl;

  for (const part of (input.dashboardHosts ?? "").split(/[\s,]+/)) {
    const entry = part.trim();
    if (!entry) continue;
    try {
      if (/^https?:\/\//i.test(entry)) return new URL(entry).origin;
      const u = new URL(`${publicUrl.protocol}//${entry}`);
      if (!u.port) u.port = publicUrl.port;
      return u.origin;
    } catch {
      continue;
    }
  }
  return input.publicBaseUrl;
}

const publicBaseUrl = optional("PUBLIC_BASE_URL", "http://localhost:3000").replace(
  /\/$/,
  "",
);

export const env = {
  databaseUrl: required("DATABASE_URL"),
  publicBaseUrl,
  // Where alert links to the dashboard point. Set DASHBOARD_BASE_URL when the
  // dashboard is not on PUBLIC_BASE_URL and the default above guesses wrong.
  dashboardBaseUrl: resolveDashboardBaseUrl({
    dashboardBaseUrl: process.env.DASHBOARD_BASE_URL,
    publicBaseUrl,
    publicOnlyHosts: process.env.PUBLIC_ONLY_HOSTS,
    dashboardHosts: process.env.DASHBOARD_HOSTS,
  }),
  publicPath: normalizePublicPath(process.env.MANTIS_PUBLIC_PATH),
  smtpUrl: process.env.SMTP_URL,
  smtpFrom: process.env.SMTP_FROM ?? "Mantis <mantis@localhost>",
  bootstrapApiKey: process.env.BOOTSTRAP_API_KEY,
  // Server-side pepper for HMAC-hashing API keys at rest. Required —
  // generate one with `openssl rand -base64 32` and put it in your .env.
  // Existing deployments upgrading from the SHA-256 era: set this once and
  // existing keys keep working via dual-mode verify (and re-hash on next
  // use). See docs/cli-backup or src/lib/api-keys.ts for the full story.
  apiKeyPepper: required("MANTIS_API_KEY_PEPPER"),
  applePass: getApplePassConfig(),
};

export type ApplePassConfig = {
  certPath: string;
  certPass: string;
  teamId: string;
  passTypeId: string;
  wwdrPath?: string;
  authSecret: string;
  /** Optional path to a 58×58 PNG used as the @2x app icon. Falls back to a solid-color default. */
  iconPath?: string;
  /** Optional path to a 160×50 PNG logo. */
  logoPath?: string;
  organizationName: string;
  /** APNs key (.p8) for pushing pass updates to installed devices. Optional. */
  apnsKeyPath?: string;
  /** APNs key ID (10-char hex from Apple Developer → Certificates → Keys). */
  apnsKeyId?: string;
  /** Use sandbox APNs (api.development.push.apple.com) instead of prod. */
  apnsSandbox?: boolean;
};

function getApplePassConfig(): ApplePassConfig | null {
  const certPath = process.env.APPLE_PASS_CERT_PATH;
  const certPass = process.env.APPLE_PASS_CERT_PASS;
  const teamId = process.env.APPLE_PASS_TEAM_ID;
  const passTypeId = process.env.APPLE_PASS_TYPE_ID;
  const authSecret = process.env.APPLE_PASS_AUTH_SECRET;
  // All five are required to enable Apple Wallet. Otherwise the feature is "off".
  if (!certPath || !certPass || !teamId || !passTypeId || !authSecret) {
    return null;
  }
  return {
    certPath,
    certPass,
    teamId,
    passTypeId,
    authSecret,
    wwdrPath: process.env.APPLE_PASS_WWDR_PATH,
    iconPath: process.env.APPLE_PASS_ICON_PATH,
    logoPath: process.env.APPLE_PASS_LOGO_PATH,
    organizationName: process.env.APPLE_PASS_ORG_NAME ?? "Mantis",
    apnsKeyPath: process.env.APPLE_PASS_APNS_KEY_PATH,
    apnsKeyId: process.env.APPLE_PASS_APNS_KEY_ID,
    apnsSandbox: process.env.APPLE_PASS_APNS_SANDBOX === "1",
  };
}

export function walletWebServiceUrl(): string {
  return `${env.publicBaseUrl}/api/wallet`;
}

/** The trigger URL. Fetching it FIRES the canary — never render it as a link to follow. */
export function keyUrl(publicId: string): string {
  return `${env.publicBaseUrl}${env.publicPath}/${publicId}`;
}

/** Non-firing link to a key's dashboard page — the one alerts may link. */
export function keyDashboardUrl(keyId: string): string {
  return `${env.dashboardBaseUrl}/keys/${encodeURIComponent(keyId)}`;
}

export function statusUrl(publicId: string): string {
  return `${env.publicBaseUrl}/status/${publicId}.${statusTag(publicId)}`;
}
