import { MantisClient } from "../lib/api.js";
import {
  CloudflareAuthError,
  cloudflaredInstalled,
  fetchCloudflareJwt,
} from "../lib/cloudflare.js";
import {
  getCloudflareServiceAuth,
  getCurrentProfileName,
  getKey,
  getProfile,
  resolveAuth,
} from "../lib/config.js";
import {
  hostOnly,
  glyph,
  dot,
  arrow,
  c,
  emit,
  hintLines,
  mark,
  safeText,
} from "../lib/out.js";
import { networkReason, type GlobalOpts } from "../lib/runner.js";
import { fileURLToPath } from "node:url";
import { CLI_VERSION } from "../version.js";

export type DoctorOpts = GlobalOpts & {
  publicUrl?: string;
};

type Check = {
  name: string;
  status: "ok" | "warn" | "fail";
  detail: string;
  hint?: string;
};

/** A check plus wording that only the terminal view uses; --json omits it. */
type ShownCheck = Check & { shown?: string; skipped?: boolean };

export async function doctorCmd(opts: DoctorOpts): Promise<void> {
  const checks: ShownCheck[] = [];
  const add = (
    status: Check["status"],
    name: string,
    detail: string,
    hint?: string,
    shown?: string,
  ) => checks.push({ status, name, detail, hint, shown });
  // Nothing to check here: still "ok" to --json, drawn as skipped on a terminal.
  const skip = (name: string, detail: string) =>
    checks.push({ status: "ok", name, detail, skipped: true });

  const selectedProfile = opts.baseUrl
    ? undefined
    : opts.profile ?? (await getCurrentProfileName());
  const profile = selectedProfile ? await getProfile(selectedProfile) : null;
  const baseUrl = normalizeUrl(opts.baseUrl ?? profile?.baseUrl);

  if (selectedProfile && profile) {
    add(
      "ok",
      "profile",
      `${selectedProfile} -> ${profile.baseUrl}`,
      undefined,
      `${selectedProfile} ${arrow.right()} ${hostOnly(profile.baseUrl)}`,
    );
  } else if (opts.baseUrl) {
    add("ok", "profile", "using --base-url override");
  } else {
    add(
      "fail",
      "profile",
      "no active profile",
      "Run `mantis login` or pass --base-url and --key",
    );
  }

  if (baseUrl) {
    const storedKey = opts.key ?? getKey(baseUrl);
    if (storedKey) {
      add(
        "ok",
        "api key",
        `${storedKey.slice(0, 12)}...`,
        undefined,
        `${storedKey.slice(0, 12)}${glyph("…", "...")}${storedKey.slice(-4)}`,
      );
    } else {
      add(
        "fail",
        "api key",
        `no API key for ${baseUrl}`,
        "Run `mantis login` or pass --key",
      );
    }
  }

  if (profile?.cloudflareAccessMode === "service-auth") {
    const creds = baseUrl ? getCloudflareServiceAuth(baseUrl) : null;
    add(
      creds ? "ok" : "fail",
      "cloudflare access",
      creds ? "service-auth credentials are stored" : "service-auth is configured but credentials are missing",
      creds ? undefined : "Run `mantis cloudflare set-service-auth`",
    );
  } else if (profile?.cloudflareAccessMode === "sso") {
    const installed = cloudflaredInstalled();
    add(
      installed ? "ok" : "fail",
      "cloudflared",
      installed ? "cloudflared is installed" : "cloudflared is not installed",
      installed ? undefined : "Install cloudflared or switch to service-auth",
    );
    if (installed && profile.cloudflareAccessAppUrl) {
      try {
        fetchCloudflareJwt(profile.cloudflareAccessAppUrl);
        add("ok", "cloudflare token", "cached Access token is available");
      } catch (err) {
        add(
          err instanceof CloudflareAuthError ? "warn" : "fail",
          "cloudflare token",
          err instanceof Error ? err.message : String(err),
          "Run `mantis cloudflare login`",
        );
      }
    }
  } else {
    skip("cloudflare access", "not configured for this profile");
  }

  let samplePublicOrigin = normalizeUrl(opts.publicUrl);
  if (baseUrl && (opts.key || getKey(baseUrl))) {
    try {
      const auth = await resolveAuth({
        baseUrl: opts.baseUrl,
        key: opts.key,
        profile: opts.profile,
      });
      const client = new MantisClient(auth, {
        timeoutMs: parseTimeoutMs(opts.timeout),
        retries: parseRetries(opts.retries),
      });

      try {
        const health = await client.health();
        add(
          health.status === "ok" ? "ok" : "warn",
          "server health",
          `server ${health.status}${health.db ? `, db ${health.db}` : ""}`,
        );
        if (health.version) {
          add(
            health.version === CLI_VERSION ? "ok" : "warn",
            "version",
            `cli ${CLI_VERSION}, server ${health.version}`,
            health.version === CLI_VERSION
              ? undefined
              : compareVersions(CLI_VERSION, health.version) < 0
                ? `CLI is older: ${upgradeCommand()}`
                : "Server is older: upgrade it when convenient",
          );
        }
      } catch (err) {
        add(
          "fail",
          "server health",
          err instanceof Error ? err.message : String(err),
          "Check the private dashboard/API URL and Access policy",
        );
      }

      try {
        const page = await client.ping();
        add("ok", "api auth", "authenticated /api/keys request succeeded");
        const firstKeyUrl = page.data[0]?.url;
        const detected = originOf(firstKeyUrl);
        if (!samplePublicOrigin && detected && detected !== client.baseUrl) {
          samplePublicOrigin = detected;
        }
        if (detected && detected !== client.baseUrl) {
          add(
            "ok",
            "split hosts",
            `${client.baseUrl} private, ${detected} public`,
            undefined,
            `private ${hostOnly(client.baseUrl)} ${dot()} public ${hostOnly(detected)}`,
          );
        } else if (page.data.length === 0 && !samplePublicOrigin) {
          add(
            "warn",
            "split hosts",
            "no keys exist, so public trigger host could not be auto-detected",
            "Pass --public-url to verify the public side",
          );
        } else if (!samplePublicOrigin) {
          add("warn", "split hosts", "dashboard/API and trigger URLs appear to share one origin");
        }
      } catch (err) {
        add(
          "fail",
          "api auth",
          err instanceof Error ? err.message : String(err),
          "Run `mantis login` again or check Cloudflare/Tailscale access",
        );
      }
    } catch (err) {
      add(
        "fail",
        "auth resolution",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  if (samplePublicOrigin && baseUrl && samplePublicOrigin !== baseUrl) {
    await checkPublicSplit(samplePublicOrigin, add, parseTimeoutMs(opts.timeout));
  }

  const ok = !checks.some((check) => check.status === "fail");
  emit(
    () => {
      const w = process.stdout.write.bind(process.stdout);
      const nameWidth = Math.max(...checks.map((ch) => ch.name.length));
      const under = " ".repeat(2 + nameWidth + 2);
      checks.forEach((check, i) => {
        // Details quote the server (health fields, error strings) and config.
        const detail = safeText(check.shown ?? check.detail);
        const name = safeText(check.name).padEnd(nameWidth);
        if (check.skipped) {
          w(`${mark("none")} ${c.dim(name)}  ${c.dim(`skipped: ${detail}`)}\n`);
          return;
        }
        const kind = check.status === "ok" ? "ok" : check.status;
        w(`${mark(kind)} ${check.status === "ok" ? name : c.bold(name)}  ${detail}\n`);
        // Checks that fail the same way share one hint, under the last of them.
        if (check.hint && checks[i + 1]?.hint !== check.hint) {
          w(hintLines(`${arrow.right()} ${check.hint}`, under));
        }
      });
      const count = (status: Check["status"]) =>
        checks.filter((ch) => ch.status === status && !ch.skipped).length;
      const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
      const failed = count("fail");
      const warned = count("warn");
      const skipped = checks.filter((ch) => ch.skipped).length;
      const parts = [`${count("ok")} passed`];
      if (skipped) parts.push(`${skipped} skipped`);
      // The counts that need acting on carry the colour; the rest stay quiet.
      if (warned) parts.push(c.warning(plural(warned, "warning")));
      if (failed) parts.push(c.alarm(`${failed} failed`));
      w(`\n${mark(failed ? "fail" : warned ? "warn" : "ok")} ${parts.join(", ")}\n`);
    },
    {
      ok,
      checks: checks.map(({ name, status, detail, hint }) => ({
        status,
        name,
        detail,
        hint,
      })),
    },
  );
  process.exitCode = ok ? 0 : 1;
}

async function checkPublicSplit(
  publicOrigin: string,
  add: (
    status: Check["status"],
    name: string,
    detail: string,
    hint?: string,
    shown?: string,
  ) => number,
  timeoutMs: number | undefined,
): Promise<void> {
  const login = await fetchPublic(publicOrigin, "/login", timeoutMs);
  addPublicOnlyCheck(add, "public /login", login, `${publicOrigin}/login`);

  const api = await fetchPublic(publicOrigin, "/api/keys", timeoutMs);
  addPublicOnlyCheck(add, "public /api", api, `${publicOrigin}/api/keys`);

  // No probe of the public status route: a status URL only answers with the
  // per-key capability the server puts in monitor_status_url, and anything
  // the CLI could build itself gets the same 404 as a blocked path. Whether
  // the public host is reachable at all is already shown by the probes above.
}

function addPublicOnlyCheck(
  add: (
    status: Check["status"],
    name: string,
    detail: string,
    hint?: string,
    shown?: string,
  ) => number,
  name: string,
  result: { ok: true; status: number } | { ok: false; message: string; code?: string },
  tried: string,
): void {
  if (!result.ok) {
    add(
      "warn",
      name,
      result.message,
      `Both checks: fix DNS or the tunnel, rerun \`mantis doctor\``,
      `${hostOnly(tried)}: ${networkReason(result.code, result.message)}`,
    );
    return;
  }
  if (result.status === 404) {
    add("ok", name, "hidden on the public host");
    return;
  }
  add(
    "fail",
    name,
    `returned HTTP ${result.status} on the public host`,
    "Sensitive dashboard/API paths should be served only on the private host",
  );
}

async function fetchPublic(
  origin: string,
  path: string,
  timeoutMs = 5000,
): Promise<
  { ok: true; status: number } | { ok: false; message: string; code?: string }
> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(new URL(path, origin), {
      signal: controller.signal,
      redirect: "manual",
    });
    return { ok: true, status: res.status };
  } catch (err) {
    const cause = (err as { cause?: { code?: unknown } }).cause;
    const code =
      err instanceof Error && err.name === "AbortError"
        ? "ETIMEDOUT"
        : typeof cause?.code === "string"
          ? cause.code
          : undefined;
    return {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
      code,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** The upgrade command for the way this CLI was installed (Homebrew or npm). */
function upgradeCommand(): string {
  const here = fileURLToPath(import.meta.url);
  return /\/(Cellar|homebrew)\//.test(here)
    ? "`brew upgrade mantis`"
    : "`npm i -g @mantis/cli` or `brew upgrade mantis`";
}

/** Numeric compare of `x.y.z` strings: negative when a is older than b. */
function compareVersions(a: string, b: string): number {
  const parse = (v: string) => v.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const [pa, pb] = [parse(a), parse(b)];
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function normalizeUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    return `${url.protocol}//${url.host}`;
  } catch {
    return raw.replace(/\/+$/, "");
  }
}

function originOf(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    return `${url.protocol}//${url.host}`;
  } catch {
    return undefined;
  }
}

function parseTimeoutMs(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const value = raw.trim().toLowerCase();
  const match = /^(\d+(?:\.\d+)?)(ms|s|m)?$/.exec(value);
  if (!match) return undefined;
  const n = Number(match[1]);
  const unit = match[2] ?? "s";
  return Math.round(n * (unit === "ms" ? 1 : unit === "m" ? 60_000 : 1000));
}

function parseRetries(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isInteger(n) ? n : undefined;
}
