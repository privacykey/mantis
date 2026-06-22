import { createInterface, type Interface } from "node:readline/promises";
import { MantisClient } from "../lib/api.js";
import {
  DEFAULT_PROFILE,
  getCurrentProfileName,
  getProfile,
  setKey,
  setProfile,
  useProfile,
} from "../lib/config.js";
import { c, ExitCode, fail, isJsonMode } from "../lib/out.js";
import { canPrompt, readStdin } from "../lib/prompt.js";

const KEY_RE = /^mantis_live_[A-Za-z0-9_-]+$/;
const URL_RE = /^https?:\/\/.+/;

export async function loginCmd(opts: {
  url?: string;
  key?: string;
  /** Read the API key from stdin instead of prompting (leak-free for CI). */
  keyStdin?: boolean;
  profile?: string;
  /** Don't set this profile as the active one (e.g. when adding a second profile). */
  noSwitch?: boolean;
}): Promise<void> {
  const profileName =
    opts.profile ?? (await getCurrentProfileName()) ?? DEFAULT_PROFILE;
  const existing = await getProfile(profileName);

  let url = opts.url ?? existing?.baseUrl ?? "";
  let key = opts.key ?? "";
  if (!key && opts.keyStdin) {
    key = (await readStdin()).trim();
    if (!key) {
      return fail("login: --key-stdin was set but stdin was empty", ExitCode.Usage);
    }
  }

  // We must prompt if the URL still isn't known or the key wasn't supplied.
  // Without a usable terminal that would silently read piped/empty data and
  // surface a misleading "invalid URL"; fail with actionable guidance instead.
  const interactive = !isJsonMode() && canPrompt();
  if ((!url || !key) && !interactive) {
    return fail(
      "login needs an interactive terminal. To run non-interactively, pass --url and supply the key via --key-stdin (or --key).",
      ExitCode.Usage,
    );
  }

  let rl: Interface | undefined;
  try {
    if (interactive && !opts.url) {
      rl ??= createInterface({ input: process.stdin, output: process.stderr });
      const prompt = url ? `Base URL [${url}]: ` : "Base URL: ";
      const answer = (await rl.question(prompt)).trim();
      if (answer) url = answer;
    }
    if (!URL_RE.test(url)) {
      return fail(`invalid URL: ${url}`, ExitCode.Usage);
    }
    url = url.replace(/\/$/, "");

    if (interactive && !key) {
      rl ??= createInterface({ input: process.stdin, output: process.stderr });
      process.stderr.write(
        `${c.dim('This is the bootstrap admin key printed to the server logs on first boot:')}\n` +
          `${c.dim('  docker compose logs mantis | grep "bootstrap API key" -A1')}\n` +
          `${c.dim("(or whatever you set via BOOTSTRAP_API_KEY)")}\n`,
      );
      key = (await rl.question("API key (mantis_live_...): ")).trim();
    }
    if (!KEY_RE.test(key)) {
      return fail(
        'invalid API key format. The key is the bootstrap admin key printed to the server logs on first boot:\n' +
          '  docker compose logs mantis | grep "bootstrap API key" -A1\n' +
          "(or whatever you set via BOOTSTRAP_API_KEY)",
        ExitCode.Usage,
      );
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
    process.stderr.write(
      `${c.dim("Next:")} ${c.cyan("mantis doctor")} ${c.dim("# verify server health & auth")}\n`,
    );
  } finally {
    rl?.close();
  }
}
