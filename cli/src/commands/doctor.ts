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
import { c, emit } from "../lib/out.js";
import type { GlobalOpts } from "../lib/runner.js";
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

export async function doctorCmd(opts: DoctorOpts): Promise<void> {
  const checks: Check[] = [];
  const add = (
    status: Check["status"],
    name: string,
    detail: string,
    hint?: string,
  ) => checks.push({ status, name, detail, hint });

  const selectedProfile = opts.baseUrl
    ? undefined
    : opts.profile ?? (await getCurrentProfileName());
  const profile = selectedProfile ? await getProfile(selectedProfile) : null;
  const baseUrl = normalizeUrl(opts.baseUrl ?? profile?.baseUrl);

  if (selectedProfile && profile) {
    add("ok", "profile", `${selectedProfile} -> ${profile.baseUrl}`);
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
      add("ok", "api key", `${storedKey.slice(0, 12)}...`);
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
    add("ok", "cloudflare access", "not configured for this profile");
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
              : "Upgrade the older side when convenient",
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
          add("ok", "split hosts", `${client.baseUrl} private, ${detected} public`);
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
      process.stdout.write(c.bold("mantis doctor\n"));
      for (const check of checks) {
        const label =
          check.status === "ok"
            ? c.green("ok")
            : check.status === "warn"
            ? c.yellow("warn")
            : c.red("fail");
        process.stdout.write(`${label.padEnd(9)} ${c.bold(check.name)}: ${check.detail}\n`);
        if (check.hint) process.stdout.write(`          ${c.dim(check.hint)}\n`);
      }
    },
    { ok, checks },
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
  ) => number,
  timeoutMs: number | undefined,
): Promise<void> {
  const login = await fetchPublic(publicOrigin, "/login", timeoutMs);
  addPublicOnlyCheck(add, "public /login", login);

  const api = await fetchPublic(publicOrigin, "/api/keys", timeoutMs);
  addPublicOnlyCheck(add, "public /api", api);

  const status = await fetchPublic(publicOrigin, "/status/nonexistent", timeoutMs);
  if (status.ok && status.status === 404) {
    add("ok", "public status", "status route is reachable on the public host");
  } else if (status.ok) {
    add(
      "warn",
      "public status",
      `/status/nonexistent returned HTTP ${status.status}`,
      "Public trigger/status routes may not be served from this host",
    );
  } else {
    add(
      "warn",
      "public status",
      status.message,
      "Verify the public trigger hostname is reachable",
    );
  }
}

function addPublicOnlyCheck(
  add: (
    status: Check["status"],
    name: string,
    detail: string,
    hint?: string,
  ) => number,
  name: string,
  result: { ok: true; status: number } | { ok: false; message: string },
): void {
  if (!result.ok) {
    add("warn", name, result.message, "Could not verify the public-only host");
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
): Promise<{ ok: true; status: number } | { ok: false; message: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(new URL(path, origin), {
      signal: controller.signal,
      redirect: "manual",
    });
    return { ok: true, status: res.status };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
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
