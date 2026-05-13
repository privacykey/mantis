import {
  getCloudflareServiceAuth,
  getCurrentProfileName,
  getKey,
  getProfile,
} from "../lib/config.js";
import { c, emit, fail } from "../lib/out.js";

export async function whoamiCmd(opts: { profile?: string } = {}): Promise<void> {
  const profileName = opts.profile ?? (await getCurrentProfileName());
  if (!profileName) {
    return fail("not logged in. Run `mantis login`");
  }
  const entry = await getProfile(profileName);
  if (!entry) return fail(`profile '${profileName}' not found`);

  const key = getKey(entry.baseUrl);
  const cfMode = entry.cloudflareAccessMode;
  const cfApp = entry.cloudflareAccessAppUrl;
  const sa =
    cfMode === "service-auth" ? getCloudflareServiceAuth(entry.baseUrl) : null;

  emit(
    () => {
      process.stdout.write(`${c.dim("profile:   ")} ${c.bold(profileName)}\n`);
      process.stdout.write(`${c.dim("server:    ")} ${entry.baseUrl}\n`);
      process.stdout.write(
        `${c.dim("key:       ")} ${entry.keyPrefix ?? key?.slice(0, 18) ?? "(missing)"}${key ? "" : c.red(" (no keychain entry)")}\n`,
      );
      if (cfMode === "sso") {
        process.stdout.write(
          `${c.dim("cloudflare:")} ${c.cyan("sso")} (app: ${cfApp ?? entry.baseUrl})\n`,
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
          `${c.dim("edge:      ")} ${entry.edgeWorkerUrl}\n`,
        );
      }
    },
    {
      profile: profileName,
      base_url: entry.baseUrl,
      key_prefix: entry.keyPrefix ?? key?.slice(0, 18) ?? null,
      has_key: Boolean(key),
      cloudflare_mode: cfMode ?? "off",
      cloudflare_app_url: cfApp ?? null,
      cloudflare_service_auth_present:
        cfMode === "service-auth" ? Boolean(sa) : null,
      edge_worker_url: entry.edgeWorkerUrl ?? null,
    },
  );
}
