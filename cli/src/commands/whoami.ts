import {
  getCloudflareServiceAuth,
  getCurrentProfileName,
  getKey,
  getProfile,
} from "../lib/config.js";
import { c, emit, fail, safeText } from "../lib/out.js";

export async function whoamiCmd(opts: { profile?: string } = {}): Promise<void> {
  const profileName = opts.profile ?? (await getCurrentProfileName());
  if (!profileName) {
    return fail("not logged in. Run `mantis login`");
  }
  const entry = await getProfile(profileName);
  if (!entry) return fail(`profile '${profileName}' not found`);

  const key = getKey(entry.baseUrl);
  // The key is stored per server URL and shared by every profile for it, so
  // the prefix recorded on this profile goes stale when a login or restore
  // under another profile name replaces the key. Report what is stored.
  const stalePrefix = Boolean(
    key && entry.keyPrefix && !key.startsWith(entry.keyPrefix),
  );
  const keyPrefix = stalePrefix
    ? key!.slice(0, 18)
    : (entry.keyPrefix ?? key?.slice(0, 18) ?? null);
  const cfMode = entry.cloudflareAccessMode;
  const cfApp = entry.cloudflareAccessAppUrl;
  const sa =
    cfMode === "service-auth" ? getCloudflareServiceAuth(entry.baseUrl) : null;

  emit(
    () => {
      process.stdout.write(`${c.dim("profile:   ")} ${c.bold(safeText(profileName))}\n`);
      process.stdout.write(`${c.dim("server:    ")} ${safeText(entry.baseUrl)}\n`);
      process.stdout.write(
        `${c.dim("key:       ")} ${safeText(keyPrefix ?? "(missing)")}${key ? "" : c.red(" (no keychain entry)")}${stalePrefix ? c.yellow(` (this profile recorded ${safeText(entry.keyPrefix)}; the key stored for this server has been replaced since)`) : ""}\n`,
      );
      if (cfMode === "sso") {
        process.stdout.write(
          `${c.dim("cloudflare:")} ${c.cyan("sso")} (app: ${safeText(cfApp ?? entry.baseUrl)})\n`,
        );
      } else if (cfMode === "service-auth") {
        process.stdout.write(
          `${c.dim("cloudflare:")} ${c.cyan("service-auth")}${
            sa ? "" : c.red(" (keychain entry missing)")
          }\n`,
        );
      } else {
        process.stdout.write(`${c.dim("cloudflare:")} ${c.dim("off")}\n`);
      }
      if (entry.edgeWorkerUrl) {
        process.stdout.write(
          `${c.dim("edge:      ")} ${safeText(entry.edgeWorkerUrl)}\n`,
        );
      }
    },
    {
      profile: profileName,
      base_url: entry.baseUrl,
      key_prefix: keyPrefix,
      key_prefix_stale: stalePrefix,
      has_key: Boolean(key),
      cloudflare_mode: cfMode ?? "off",
      cloudflare_app_url: cfApp ?? null,
      cloudflare_service_auth_present:
        cfMode === "service-auth" ? Boolean(sa) : null,
      edge_worker_url: entry.edgeWorkerUrl ?? null,
    },
  );
}
