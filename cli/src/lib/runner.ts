import { ApiError, RequestTimeoutError } from "./api.js";
import { MantisClient } from "./api.js";
import { AuthError, listProfiles, resolveAuth } from "./config.js";
import { listEdgeKeyWorkers } from "./edge-key.js";
import { c, ExitCode, fail, isDebug } from "./out.js";
import { ResolveError } from "./resolve.js";

/** A bad flag/argument value — exits with ExitCode.Usage. */
export class UsageError extends Error {}

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
    if (isDebug()) {
      const target = globals.profile
        ? `profile=${globals.profile}`
        : globals.baseUrl
          ? `base-url=${globals.baseUrl}`
          : "auth=env/keychain";
      const detail =
        err instanceof Error && err.stack ? err.stack : String(err);
      process.stderr.write(c.dim(`[debug] ${target}\n[debug] ${detail}\n`));
    }
    if (err instanceof UsageError) return fail(err.message, ExitCode.Usage);
    if (err instanceof AuthError) {
      // If the user never configured a server at all but DOES have a
      // mantis-edge worker set up, point them at `mantis edge mint`
      // instead of pushing them to `mantis login` for a server they
      // don't have. We only do this for "no profile configured" — once
      // a server profile exists, "no API key" / "profile not found"
      // are real server-intent errors and edge isn't the answer.
      if (err.message.startsWith("no profile configured")) {
        const hint = await edgeSuggestion();
        if (hint) return fail(`${err.message}\n        ${hint}`, ExitCode.Auth);
        // Nothing configured at all — not a server, not an edge worker. The
        // base message assumes a server already exists to log into, which is
        // exactly wrong for someone who just installed the CLI. Point them at
        // the guided setup instead of leaving them to infer it.
        return fail(
          `${err.message}\n        New here? Run \`mantis init\` — it asks whether you want a server or a stateless Cloudflare Worker, and sets it up.`,
          ExitCode.Auth,
        );
      }
      return fail(err.message, ExitCode.Auth);
    }
    if (err instanceof ResolveError) return fail(err.message, ExitCode.NotFound);
    if (err instanceof RequestTimeoutError) {
      return fail(
        `${err.message}. Try --timeout with a larger value`,
        ExitCode.Network,
      );
    }
    if (err instanceof ApiError) {
      return fail(
        `${err.message} (HTTP ${err.status})${apiHint(err)}`,
        apiExitCode(err.status),
      );
    }
    const message = err instanceof Error ? err.message : String(err);
    const isNetwork = /fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET/i.test(
      message,
    );
    return fail(
      `${message}${genericHint(message)}`,
      isNetwork ? ExitCode.Network : ExitCode.Generic,
    );
  }
}

function apiExitCode(status: number): number {
  if (status === 401 || status === 403) return ExitCode.Auth;
  if (status === 404) return ExitCode.NotFound;
  if (status >= 500) return ExitCode.Server;
  return ExitCode.Generic;
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
    throw new UsageError("--timeout must look like 500ms, 5s, or 1m");
  }
  const n = Number(match[1]);
  const unit = match[2] ?? "s";
  const multiplier = unit === "ms" ? 1 : unit === "m" ? 60_000 : 1000;
  const ms = Math.round(n * multiplier);
  if (!Number.isFinite(ms) || ms < 1) {
    throw new UsageError("--timeout must be greater than zero");
  }
  return ms;
}

function parseRetries(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 5) {
    throw new UsageError("--retries must be an integer from 0 to 5");
  }
  return n;
}
