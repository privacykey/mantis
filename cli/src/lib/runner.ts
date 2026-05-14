import { ApiError, RequestTimeoutError } from "./api.js";
import { MantisClient } from "./api.js";
import { AuthError, listProfiles, resolveAuth } from "./config.js";
import { listEdgeKeyWorkers } from "./edge-key.js";
import { fail } from "./out.js";
import { ResolveError } from "./resolve.js";

export type GlobalOpts = {
  baseUrl?: string;
  key?: string;
  profile?: string;
  json?: boolean;
  quiet?: boolean;
  output?: string;
  noHeaders?: boolean;
  timeout?: string;
  retries?: string;
};

export async function withClient<T>(
  globals: GlobalOpts,
  fn: (client: MantisClient) => Promise<T>,
): Promise<T> {
  try {
    const auth = await resolveAuth({
      baseUrl: globals.baseUrl,
      key: globals.key,
      profile: globals.profile,
    });
    const client = new MantisClient(auth, {
      timeoutMs: parseTimeoutMs(globals.timeout),
      retries: parseRetries(globals.retries),
    });
    return await fn(client);
  } catch (err) {
    if (err instanceof AuthError) {
      // If the user never configured a server at all but DOES have a
      // mantis-edge worker set up, point them at `mantis edge mint`
      // instead of pushing them to `mantis login` for a server they
      // don't have. We only do this for "no profile configured" — once
      // a server profile exists, "no API key" / "profile not found"
      // are real server-intent errors and edge isn't the answer.
      if (err.message.startsWith("no profile configured")) {
        const hint = await edgeSuggestion();
        if (hint) return fail(`${err.message}\n        ${hint}`);
      }
      return fail(err.message);
    }
    if (err instanceof ResolveError) return fail(err.message);
    if (err instanceof RequestTimeoutError) {
      return fail(`${err.message}. Try --timeout with a larger value`);
    }
    if (err instanceof ApiError) {
      return fail(`${err.message} (HTTP ${err.status})${apiHint(err)}`);
    }
    const message = err instanceof Error ? err.message : String(err);
    return fail(`${message}${genericHint(message)}`);
  }
}

/**
 * If the user has at least one mantis-edge worker configured (keychain key
 * or a profile with `edgeWorkerUrl`), return a hint pointing them at
 * `mantis edge mint`. Returns null when there's no edge config to surface.
 */
async function edgeSuggestion(): Promise<string | null> {
  const [keychainUrls, profilesResult] = await Promise.all([
    listEdgeKeyWorkers().catch(() => []),
    listProfiles().catch(() => ({ current: null, profiles: [] })),
  ]);
  const profileWorkers = profilesResult.profiles
    .map((p) => p.entry.edgeWorkerUrl)
    .filter((u): u is string => Boolean(u));
  const all = new Set<string>([...keychainUrls, ...profileWorkers]);
  if (all.size === 0) return null;
  if (all.size === 1) {
    const url = [...all][0]!;
    return `You have a mantis-edge worker configured (${url}) — if you don't have a server, run \`mantis edge mint\` instead.`;
  }
  return `You have ${all.size} mantis-edge workers configured — if you don't have a server, run \`mantis edge mint\` instead.`;
}

function apiHint(err: ApiError): string {
  if (err.status === 401) {
    return ". Run `mantis login` again or pass --key";
  }
  if (err.status === 403) {
    return ". If this server is behind Cloudflare Access, run `mantis cloudflare status`";
  }
  if (err.status === 404) {
    return ". Check the key id, or run `mantis list`";
  }
  if (err.status >= 500) {
    return ". Check the mantis server logs";
  }
  return "";
}

function genericHint(message: string): string {
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET/i.test(message)) {
    return ". Check `mantis whoami`, pass --base-url, or verify the server is reachable";
  }
  if (/cloudflared|Cloudflare Access/i.test(message)) {
    return ". Run `mantis cloudflare status` for auth details";
  }
  return "";
}

function parseTimeoutMs(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const value = raw.trim().toLowerCase();
  const match = /^(\d+(?:\.\d+)?)(ms|s|m)?$/.exec(value);
  if (!match) {
    throw new Error("--timeout must look like 500ms, 5s, or 1m");
  }
  const n = Number(match[1]);
  const unit = match[2] ?? "s";
  const multiplier = unit === "ms" ? 1 : unit === "m" ? 60_000 : 1000;
  const ms = Math.round(n * multiplier);
  if (!Number.isFinite(ms) || ms < 1) {
    throw new Error("--timeout must be greater than zero");
  }
  return ms;
}

function parseRetries(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 5) {
    throw new Error("--retries must be an integer from 0 to 5");
  }
  return n;
}
