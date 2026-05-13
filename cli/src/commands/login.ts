import { createInterface } from "node:readline/promises";
import { MantisClient } from "../lib/api.js";
import {
  DEFAULT_PROFILE,
  getCurrentProfileName,
  getProfile,
  setKey,
  setProfile,
  useProfile,
} from "../lib/config.js";
import { c, fail } from "../lib/out.js";

const KEY_RE = /^mantis_live_[A-Za-z0-9_-]+$/;
const URL_RE = /^https?:\/\/.+/;

export async function loginCmd(opts: {
  url?: string;
  key?: string;
  profile?: string;
  /** Don't set this profile as the active one (e.g. when adding a second profile). */
  noSwitch?: boolean;
}): Promise<void> {
  const profileName =
    opts.profile ?? (await getCurrentProfileName()) ?? DEFAULT_PROFILE;
  const existing = await getProfile(profileName);

  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    let url = opts.url ?? existing?.baseUrl ?? "";
    if (!opts.url) {
      const prompt = url ? `Base URL [${url}]: ` : "Base URL: ";
      const answer = (await rl.question(prompt)).trim();
      if (answer) url = answer;
    }
    if (!URL_RE.test(url)) {
      return fail(`invalid URL: ${url}`);
    }
    url = url.replace(/\/$/, "");

    let key = opts.key ?? "";
    if (!key) {
      const answer = (await rl.question("API key (mantis_live_...): ")).trim();
      key = answer;
    }
    if (!KEY_RE.test(key)) {
      return fail("invalid API key format");
    }

    const client = new MantisClient({ baseUrl: url, key });
    try {
      await client.ping();
    } catch (err) {
      return fail(
        `failed to authenticate against ${url}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    setKey(url, key);
    await setProfile(profileName, {
      baseUrl: url,
      keyPrefix: key.slice(0, 18),
      cloudflareAccessAppUrl: existing?.cloudflareAccessAppUrl,
      cloudflareAccessMode: existing?.cloudflareAccessMode,
      edgeWorkerUrl: existing?.edgeWorkerUrl,
    });
    if (!opts.noSwitch) {
      await useProfile(profileName);
    }

    process.stderr.write(
      `${c.green("✓")} stored credentials for ${c.cyan(url)} as profile ${c.bold(profileName)}${opts.noSwitch ? c.dim(" (not switched to)") : ""}\n`,
    );
  } finally {
    rl.close();
  }
}
