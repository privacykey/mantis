import { createInterface } from "node:readline/promises";
import {
  cloudflareInteractiveLogin,
  cloudflareInteractiveLogout,
  cloudflaredInstalled,
  fetchCloudflareJwt,
  CloudflareAuthError,
} from "../lib/cloudflare.js";
import {
  deleteCloudflareServiceAuth,
  getCloudflareServiceAuth,
  getCurrentProfileName,
  getProfile,
  patchProfile,
  setCloudflareServiceAuth,
} from "../lib/config.js";
import { c, emit, fail, isJsonMode } from "../lib/out.js";
import { canPrompt, readStdin } from "../lib/prompt.js";

async function requireCurrentProfile(): Promise<{
  name: string;
  baseUrl: string;
  cloudflareAccessAppUrl?: string;
  cloudflareAccessMode?: "sso" | "service-auth";
}> {
  const name = await getCurrentProfileName();
  if (!name) {
    throw new ProfileMissing("not logged in to mantis. Run `mantis login` first.");
  }
  const entry = await getProfile(name);
  if (!entry) {
    throw new ProfileMissing(
      `profile '${name}' not found. Run \`mantis profile list\` to see configured profiles.`,
    );
  }
  return {
    name,
    baseUrl: entry.baseUrl,
    cloudflareAccessAppUrl: entry.cloudflareAccessAppUrl,
    cloudflareAccessMode: entry.cloudflareAccessMode,
  };
}

class ProfileMissing extends Error {}

export type CfLoginOpts = { app?: string };

export async function cloudflareLoginCmd(opts: CfLoginOpts): Promise<void> {
  let cfg: Awaited<ReturnType<typeof requireCurrentProfile>>;
  try {
    cfg = await requireCurrentProfile();
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }

  const appUrl = (opts.app ?? cfg.baseUrl).replace(/\/$/, "");

  if (!cloudflaredInstalled()) {
    return fail(
      "`cloudflared` binary not found. Install from https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/ — or use `mantis cloudflare set-service-auth` for headless setups.",
    );
  }

  process.stderr.write(
    `${c.dim("opening browser to Cloudflare Access for")} ${c.cyan(appUrl)}\n`,
  );
  try {
    cloudflareInteractiveLogin(appUrl);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }

  try {
    fetchCloudflareJwt(appUrl);
  } catch (err) {
    return fail(
      `cloudflared login completed but no token is available: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  await patchProfile(cfg.name, {
    cloudflareAccessAppUrl: appUrl,
    cloudflareAccessMode: "sso",
  });

  process.stderr.write(
    `${c.green("✓")} cloudflare access SSO configured for profile ${c.bold(cfg.name)} (mode: sso, app: ${appUrl})\n`,
  );
}

export async function cloudflareLogoutCmd(): Promise<void> {
  let cfg: Awaited<ReturnType<typeof requireCurrentProfile>>;
  try {
    cfg = await requireCurrentProfile();
  } catch {
    return;
  }

  if (cfg.cloudflareAccessAppUrl && cloudflaredInstalled()) {
    cloudflareInteractiveLogout(cfg.cloudflareAccessAppUrl);
  }
  deleteCloudflareServiceAuth(cfg.baseUrl);
  await patchProfile(cfg.name, {
    cloudflareAccessAppUrl: undefined,
    cloudflareAccessMode: undefined,
  });

  process.stderr.write(
    `${c.green("✓")} cleared cloudflare access config for profile ${c.bold(cfg.name)}\n`,
  );
}

export type CfServiceAuthOpts = {
  clientId?: string;
  clientSecret?: string;
  /** Read the client secret from stdin instead of prompting (leak-free for CI). */
  clientSecretStdin?: boolean;
};

export async function cloudflareSetServiceAuthCmd(
  opts: CfServiceAuthOpts,
): Promise<void> {
  let cfg: Awaited<ReturnType<typeof requireCurrentProfile>>;
  try {
    cfg = await requireCurrentProfile();
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }

  let clientId = opts.clientId;
  let clientSecret = opts.clientSecret;
  if (!clientSecret && opts.clientSecretStdin) {
    clientSecret = (await readStdin()).trim();
    if (!clientSecret) {
      return fail(
        "cloudflare set-service-auth: --client-secret-stdin was set but stdin was empty",
      );
    }
  }

  if ((!clientId || !clientSecret) && (isJsonMode() || !canPrompt())) {
    return fail(
      "cloudflare set-service-auth needs an interactive terminal. Pass --client-id and --client-secret (or --client-secret-stdin) to run non-interactively.",
    );
  }

  if (!clientId || !clientSecret) {
    const rl = createInterface({
      input: process.stdin,
      output: process.stderr,
    });
    try {
      if (!clientId) {
        clientId = (await rl.question("Cloudflare Access Client-ID: ")).trim();
      }
      if (!clientSecret) {
        clientSecret = (
          await rl.question("Cloudflare Access Client-Secret: ")
        ).trim();
      }
    } finally {
      rl.close();
    }
  }

  if (!clientId || !clientSecret) {
    return fail("both --client-id and --client-secret are required");
  }
  if (!clientId.endsWith(".access")) {
    process.stderr.write(
      c.yellow(
        "warning: Cloudflare Access service-token client IDs usually end in '.access'. Double-check this is correct.\n",
      ),
    );
  }

  setCloudflareServiceAuth(cfg.baseUrl, {
    client_id: clientId,
    client_secret: clientSecret,
  });
  await patchProfile(cfg.name, {
    cloudflareAccessMode: "service-auth",
    cloudflareAccessAppUrl: cfg.cloudflareAccessAppUrl ?? cfg.baseUrl,
  });

  process.stderr.write(
    `${c.green("✓")} cloudflare access service-auth configured for profile ${c.bold(cfg.name)}\n`,
  );
}

export async function cloudflareStatusCmd(): Promise<void> {
  let cfg: Awaited<ReturnType<typeof requireCurrentProfile>>;
  try {
    cfg = await requireCurrentProfile();
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
  const mode = cfg.cloudflareAccessMode;

  type StatusPayload = {
    profile: string;
    mode: "off" | "sso" | "service-auth";
    app_url: string | null;
    cloudflared_installed: boolean;
    service_auth_present?: boolean;
    token_status?: "ok" | "missing-or-expired";
    token_error?: string;
  };

  const installed = cloudflaredInstalled();

  if (!mode) {
    emit(
      () => {
        process.stdout.write(`${c.dim("profile:")} ${cfg.name}\n`);
        process.stdout.write(`${c.dim("mode:   ")} off\n`);
        process.stdout.write(
          `${c.dim("hint:   ")} run \`mantis cloudflare login --app=https://<your-mantis>\` or \`mantis cloudflare set-service-auth\`\n`,
        );
      },
      {
        profile: cfg.name,
        mode: "off",
        app_url: null,
        cloudflared_installed: installed,
      } satisfies StatusPayload,
    );
    return;
  }

  if (mode === "service-auth") {
    const sa = getCloudflareServiceAuth(cfg.baseUrl);
    emit(
      () => {
        process.stdout.write(`${c.dim("profile: ")} ${cfg.name}\n`);
        process.stdout.write(`${c.dim("mode:    ")} ${c.cyan("service-auth")}\n`);
        process.stdout.write(
          `${c.dim("client:  ")} ${sa ? sa.client_id.slice(0, 12) + "…" + sa.client_id.slice(-7) : c.red("(missing — keychain entry gone)")}\n`,
        );
      },
      {
        profile: cfg.name,
        mode: "service-auth",
        app_url: cfg.cloudflareAccessAppUrl ?? cfg.baseUrl,
        cloudflared_installed: installed,
        service_auth_present: Boolean(sa),
      } satisfies StatusPayload,
    );
    return;
  }

  // SSO mode
  const appUrl = cfg.cloudflareAccessAppUrl ?? cfg.baseUrl;
  let tokenStatus: "ok" | "missing-or-expired" = "missing-or-expired";
  let tokenError: string | undefined;
  if (installed) {
    try {
      fetchCloudflareJwt(appUrl);
      tokenStatus = "ok";
    } catch (err) {
      if (err instanceof CloudflareAuthError) tokenError = err.message;
      else tokenError = err instanceof Error ? err.message : String(err);
    }
  } else {
    tokenError = "cloudflared not installed";
  }

  emit(
    () => {
      process.stdout.write(`${c.dim("profile:     ")} ${cfg.name}\n`);
      process.stdout.write(`${c.dim("mode:        ")} ${c.cyan("sso")}\n`);
      process.stdout.write(`${c.dim("app URL:     ")} ${appUrl}\n`);
      process.stdout.write(
        `${c.dim("cloudflared:")} ${installed ? c.green("installed") : c.red("not installed")}\n`,
      );
      process.stdout.write(
        `${c.dim("token:      ")} ${
          tokenStatus === "ok"
            ? c.green("cached + valid")
            : c.red("missing or expired")
        }\n`,
      );
      if (tokenError) {
        process.stdout.write(`${c.dim("error:       ")} ${tokenError}\n`);
      }
      if (tokenStatus !== "ok") {
        process.stdout.write(
          c.dim(`hint: run \`mantis cloudflare login\` to refresh\n`),
        );
      }
    },
    {
      profile: cfg.name,
      mode: "sso",
      app_url: appUrl,
      cloudflared_installed: installed,
      token_status: tokenStatus,
      ...(tokenError ? { token_error: tokenError } : {}),
    } satisfies StatusPayload,
  );
}
