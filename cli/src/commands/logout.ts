import {
  clearConfig,
  deleteCloudflareServiceAuth,
  deleteKey,
  getCurrentProfileName,
  listProfiles,
  removeProfile,
} from "../lib/config.js";
import { c, fail } from "../lib/out.js";

export async function logoutCmd(opts: {
  profile?: string;
  all?: boolean;
} = {}): Promise<void> {
  if (opts.all) {
    const { profiles } = await listProfiles();
    for (const { entry } of profiles) {
      deleteKey(entry.baseUrl);
      deleteCloudflareServiceAuth(entry.baseUrl);
    }
    await clearConfig();
    process.stderr.write(
      `${c.green("✓")} logged out of ${profiles.length} profile(s)\n`,
    );
    return;
  }

  const target = opts.profile ?? (await getCurrentProfileName());
  if (!target) return fail("not logged in");

  const result = await removeProfile(target);
  if (!result.removed) return fail(`profile '${target}' not found`);
  if (result.baseUrl) {
    deleteKey(result.baseUrl);
    deleteCloudflareServiceAuth(result.baseUrl);
  }
  const tail = result.wasCurrent
    ? result.newCurrent
      ? c.dim(` (current → ${result.newCurrent})`)
      : ""
    : "";
  process.stderr.write(
    `${c.green("✓")} logged out of profile ${c.bold(target)}${tail}\n`,
  );
}
