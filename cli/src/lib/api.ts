import { buildCloudflareHeaders } from "./cloudflare.js";
import type { ResolvedAuth } from "./config.js";
import { c, isDebug } from "./out.js";

export type MonitorMode = "off" | "latch" | "window";
export type MonitorState = "off" | "ok" | "tripped";

export type NotificationChannel =
  | "webhook"
  | "email"
  | "slack"
  | "discord"
  | "teams"
  | "home_assistant";

export type Destination = {
  id: string;
  channel: NotificationChannel;
  target: string;
  signing_secret: string | null;
  created_at: string;
  last_activation_status: "ok" | "failed" | null;
  last_activation_error: string | null;
  last_activation_at: string | null;
};

export type DestinationWithActivation = Destination & {
  activation?: { ok: boolean; error?: string };
};

export type Key = {
  id: string;
  public_id: string;
  url: string;
  kind: string;
  memo: string;
  response_kind: "gif" | "empty" | "json" | "redirect" | "html";
  response_payload: unknown;
  destinations: Destination[];
  dedupe_window_seconds: number;
  monitor_mode: MonitorMode;
  monitor_window_seconds: number;
  monitor_reset_at: string | null;
  monitor_status_url: string | null;
  created_at: string;
  disabled_at: string | null;
  expires_at: string | null;
  disabled: boolean;
};

export type KeyWithDestinationResults = Omit<Key, "destinations"> & {
  destinations: DestinationWithActivation[];
};

export type KeyWithMonitorState = Key & {
  monitor_state?: MonitorState;
  monitor_tripped_at?: string | null;
};

export type NotificationSummary = {
  id: string;
  channel: NotificationChannel;
  target: string;
  status: "pending" | "in_flight" | "succeeded" | "failed" | "aborted";
  attempts: number;
  max_attempts: number;
  next_attempt_at: string;
  succeeded_at: string | null;
  last_error: string | null;
};

export type HostContext = {
  source: string | null;
  user: string | null;
  host: string | null;
  ssh_client: string | null;
  ssh_connection: string | null;
  ssh_client_ip: string | null;
  tty: string | null;
  sudo_cmd: string | null;
  network_interface: string | null;
  event: string | null;
  device: string | null;
  entity_id: string | null;
  automation: string | null;
  area: string | null;
  iot_mac: string | null;
  iot_ip: string | null;
};

export type Hit = {
  id: string;
  occurred_at: string;
  ip: string | null;
  user_agent: string | null;
  referer: string | null;
  headers: Record<string, string> | null;
  ua_browser: string | null;
  ua_browser_version: string | null;
  ua_os: string | null;
  ua_device: string | null;
  bot_label: string | null;
  is_duplicate: boolean;
  host_context: HostContext | null;
  notifications: NotificationSummary[];
};

export type RecentHit = Hit & {
  key: {
    id: string;
    public_id: string;
    memo: string;
  };
};

export type ApiKey = {
  id: string;
  name: string;
  prefix: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
};

export type AuditEvent = {
  id: string;
  occurred_at: string;
  event_type: string;
  actor_api_key_id: string | null;
  actor_label: string | null;
  subject_kind: string | null;
  subject_id: string | null;
  metadata: Record<string, unknown> | null;
  ip: string | null;
};

export type Page<T> = { data: T[]; next_cursor: string | null };

export type Health = {
  status: "ok" | "degraded";
  db?: "ok" | "fail";
  started_at?: string;
  version?: string;
  error?: string;
};

export type InstallerMeta = {
  type: string;
  name: string;
  description: string;
  os: "macos" | "linux" | "windows" | "posix" | "web" | "tag" | "iot";
  filename: string;
  content: string;
  install: string[];
  uninstall: string[];
  notes?: string;
};

/**
 * Device-profile catalog, fetched rather than duplicated.
 *
 * `installers.ts` in this package is a hand-maintained port of the server's
 * module and must be kept in sync by hand. Not repeating that here: the CLI
 * asks the server what a profile contains, so a new vector needs no CLI change
 * and the two can't disagree.
 */
export type DeviceExtraSetup = {
  what: string;
  why: string;
  detect: string;
  install: string[];
  requires: { detect: string; label: string };
};

export type DeviceVectorMeta = {
  slug: string;
  label: string;
  blurb: string;
  install_type: string;
  response_kind: Key["response_kind"];
  dedupe_window_seconds: number;
  needs_root: boolean;
  needs_extra_setup: DeviceExtraSetup | null;
};

export type DeviceProfileMeta = {
  os: string;
  label: string;
  blurb: string;
  /** Slugs selected unless the operator says otherwise. */
  defaults: string[];
  vectors: DeviceVectorMeta[];
};

export type DeviceBundleFiles = {
  root: string;
  installScript: string;
  uninstallScript: string;
  files: Record<string, string>;
};

export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(status: number, body: unknown, message: string) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

export type RequestPolicy = {
  timeoutMs?: number;
  retries?: number;
};

export class RequestTimeoutError extends Error {
  readonly timeoutMs: number;
  constructor(timeoutMs: number) {
    super(`request timed out after ${formatMs(timeoutMs)}`);
    this.timeoutMs = timeoutMs;
  }
}

export class RequestNetworkError extends Error {
  constructor(message: string) {
    super(message);
  }
}

export class MantisClient {
  private readonly policy: Required<RequestPolicy>;

  constructor(
    private readonly auth: ResolvedAuth,
    policy: RequestPolicy = {},
  ) {
    this.policy = {
      timeoutMs: clampInt(policy.timeoutMs, 1000, 120_000, 15_000),
      retries: clampInt(policy.retries, 0, 5, 1),
    };
  }

  get baseUrl(): string {
    return this.auth.baseUrl;
  }

  get profile(): string | undefined {
    return this.auth.profile;
  }

  private authHeaders(extraJsonBody: unknown): Record<string, string> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.auth.key}`,
    };
    if (extraJsonBody) headers["Content-Type"] = "application/json";
    const cf = buildCloudflareHeaders(this.auth.cloudflare);
    if (cf) Object.assign(headers, cf);
    return headers;
  }

  private async req<T>(
    path: string,
    init: RequestInit & { query?: Record<string, string | number | undefined> } = {},
  ): Promise<T> {
    const { query, ...rest } = init;
    const url = new URL(path, this.auth.baseUrl);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
      }
    }
    const res = await this.fetchWithPolicy(url, {
      ...rest,
      headers: {
        ...(rest.headers ?? {}),
        ...this.authHeaders(rest.body),
      },
    });
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    const body = text ? safeJson(text) : null;
    if (!res.ok) {
      const msg =
        (body && typeof body === "object" && "message" in body && typeof (body as { message?: unknown }).message === "string"
          ? (body as { message: string }).message
          : null) ??
        (body && typeof body === "object" && "error" in body && typeof (body as { error?: unknown }).error === "string"
          ? (body as { error: string }).error
          : null) ??
        `HTTP ${res.status}`;
      throw new ApiError(res.status, body, msg);
    }
    return body as T;
  }

  ping(): Promise<Page<Key>> {
    return this.req<Page<Key>>("/api/keys", { query: { limit: 1 } });
  }

  health(): Promise<Health> {
    return this.req<Health>("/api/health");
  }

  createKey(input: {
    memo: string;
    /**
     * Stable machine identity. The server absorbs a duplicate via the unique
     * index on external_id and returns the EXISTING key, which is what makes
     * `mantis device new` safe to re-run against a rebuilt host.
     */
    external_id?: string;
    response_kind?: Key["response_kind"];
    response_payload?: unknown;
    dedupe_window_seconds?: number;
    destinations?: Array<{ channel: NotificationChannel; target: string }>;
    expires_at?: string;
  }): Promise<KeyWithDestinationResults> {
    return this.req<KeyWithDestinationResults>("/api/keys", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  listKeys(query: { limit?: number; cursor?: string } = {}): Promise<Page<Key>> {
    return this.req<Page<Key>>("/api/keys", { query });
  }

  getKey(id: string): Promise<Key> {
    return this.req<Key>(`/api/keys/${encodeURIComponent(id)}`);
  }

  patchKey(
    id: string,
    patch: Partial<{
      memo: string;
      disabled: boolean;
      destinations: Array<{ channel: NotificationChannel; target: string }>;
    }>,
  ): Promise<Key> {
    return this.req<Key>(`/api/keys/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
  }

  deleteKey(id: string): Promise<void> {
    return this.req<void>(`/api/keys/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  }

  setMonitor(
    id: string,
    opts: { mode: MonitorMode; window_seconds?: number },
  ): Promise<Key> {
    const body: Record<string, unknown> = { monitor_mode: opts.mode };
    if (opts.window_seconds !== undefined) {
      body.monitor_window_seconds = opts.window_seconds;
    }
    return this.req<Key>(`/api/keys/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
  }

  resetMonitor(id: string): Promise<KeyWithMonitorState> {
    return this.req<KeyWithMonitorState>(
      `/api/keys/${encodeURIComponent(id)}/reset`,
      { method: "POST", body: "{}" },
    );
  }

  fetchStatus(
    publicId: string,
  ): Promise<{ status: "ok" | "tripped"; tripped_at?: string }> {
    const url = new URL(
      `/status/${encodeURIComponent(publicId)}`,
      this.auth.baseUrl,
    );
    return this.fetchWithPolicy(url).then(async (res) => {
      if (res.status === 404) {
        throw new ApiError(404, null, "not monitored");
      }
      const body = await res.json();
      return body as { status: "ok" | "tripped"; tripped_at?: string };
    });
  }

  listHits(
    id: string,
    query: { limit?: number; cursor?: string } = {},
  ): Promise<Page<Hit>> {
    return this.req<Page<Hit>>(
      `/api/keys/${encodeURIComponent(id)}/hits`,
      { query },
    );
  }

  listRecentHits(
    query: { limit?: number; since?: string; cursor?: string; key_id?: string } = {},
  ): Promise<Page<RecentHit>> {
    return this.req<Page<RecentHit>>("/api/hits/recent", { query });
  }

  async fetchInstaller(
    id: string,
    type: string,
    hostname?: string,
  ): Promise<InstallerMeta> {
    const url = new URL(
      `/api/keys/${encodeURIComponent(id)}/install`,
      this.auth.baseUrl,
    );
    url.searchParams.set("type", type);
    url.searchParams.set("format", "json");
    if (hostname) url.searchParams.set("hostname", hostname);
    const res = await this.fetchWithPolicy(url, { headers: this.authHeaders(null) });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new ApiError(res.status, text || null, `installer fetch failed (HTTP ${res.status})`);
    }
    return (await res.json()) as InstallerMeta;
  }

  deviceProfiles(): Promise<{ profiles: DeviceProfileMeta[] }> {
    return this.req<{ profiles: DeviceProfileMeta[] }>("/api/device-profiles");
  }

  /**
   * The bundle as a file map instead of a zip, for `--install`: the CLI writes
   * these out and runs the same bootstrap the zip ships, rather than carrying a
   * second implementation of the install recipes.
   */
  deviceBundleFiles(input: {
    device: string;
    os: string;
    vectors: Array<{ id: string; slug: string }>;
  }): Promise<DeviceBundleFiles> {
    return this.req<DeviceBundleFiles>("/api/keys/device-bundle", {
      method: "POST",
      body: JSON.stringify(input),
      query: { format: "json" },
    });
  }

  /**
   * Fetch the install bundle for an already-minted device suite. Built server
   * side so the bootstrap-script logic lives in exactly one place — the CLI
   * ships as a single binary and has no zip library of its own.
   */
  async downloadDeviceBundle(input: {
    device: string;
    os: string;
    vectors: Array<{ id: string; slug: string }>;
  }): Promise<{ data: Buffer; filename: string }> {
    const url = new URL("/api/keys/device-bundle", this.auth.baseUrl);
    const body = JSON.stringify(input);
    const res = await this.fetchWithPolicy(url, {
      method: "POST",
      body,
      headers: this.authHeaders(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new ApiError(
        res.status,
        text || null,
        `bundle failed (HTTP ${res.status})`,
      );
    }
    const disposition = res.headers.get("content-disposition") ?? "";
    const match = /filename="?([^"]+)"?/.exec(disposition);
    return {
      data: Buffer.from(await res.arrayBuffer()),
      filename: match?.[1] ?? `${input.device}-${input.os}.zip`,
    };
  }

  async downloadFile(
    id: string,
    format:
      | "docx"
      | "xlsx"
      | "pptx"
      | "pdf"
      | "folder"
      | "nfc-label"
      | "apple-wallet"
      | "svg"
      | "html"
      | "md"
      | "eml"
      | "ics"
      | "vcf"
      | "rtf"
      | "cookies"
      | "bookmarks"
      | "env"
      | "aws-credentials"
      | "netrc"
      | "kubeconfig"
      | "ovpn"
      | "rdp",
  ): Promise<{ data: Buffer; filename: string }> {
    const url = new URL(
      `/api/keys/${encodeURIComponent(id)}/download`,
      this.auth.baseUrl,
    );
    url.searchParams.set("format", format);
    const res = await this.fetchWithPolicy(url, { headers: this.authHeaders(null) });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new ApiError(res.status, text || null, `download failed (HTTP ${res.status})`);
    }
    const disposition = res.headers.get("content-disposition") ?? "";
    const match = /filename="?([^"]+)"?/.exec(disposition);
    const filename = match?.[1] ?? `mantis.${format}`;
    const data = Buffer.from(await res.arrayBuffer());
    return { data, filename };
  }

  listApiKeys(): Promise<{ data: ApiKey[] }> {
    return this.req<{ data: ApiKey[] }>("/api/api-keys");
  }

  createApiKey(name: string): Promise<ApiKey & { key: string }> {
    return this.req<ApiKey & { key: string }>("/api/api-keys", {
      method: "POST",
      body: JSON.stringify({ name }),
    });
  }

  revokeApiKey(id: string): Promise<void> {
    return this.req<void>(`/api/api-keys/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  }

  listAuditEvents(
    query: {
      limit?: number;
      cursor?: string;
      since?: string;
      event_type?: string;
      actor?: string;
    } = {},
  ): Promise<Page<AuditEvent>> {
    return this.req<Page<AuditEvent>>("/api/audit", { query });
  }

  rotateDestinationSecret(
    keyId: string,
    destinationId: string,
  ): Promise<Destination & { signing_secret: string }> {
    return this.req<Destination & { signing_secret: string }>(
      `/api/keys/${encodeURIComponent(keyId)}/destinations/${encodeURIComponent(
        destinationId,
      )}/rotate-secret`,
      { method: "POST", body: "{}" },
    );
  }

  private async fetchWithPolicy(url: URL, init: RequestInit = {}): Promise<Response> {
    const method = (init.method ?? "GET").toUpperCase();
    const retryable = method === "GET" || method === "HEAD";
    const attempts = retryable ? this.policy.retries + 1 : 1;
    let lastError: unknown;

    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const res = await fetchOnce(url, init, this.policy.timeoutMs);
        if (isDebug()) {
          const tag = attempt > 0 ? ` (attempt ${attempt + 1})` : "";
          process.stderr.write(
            c.dim(`[debug] ${method} ${url} → ${res.status}${tag}\n`),
          );
        }
        if (
          retryable &&
          attempt < attempts - 1 &&
          (res.status === 429 || res.status >= 500)
        ) {
          await res.arrayBuffer().catch(() => undefined);
          await sleep(backoffMs(attempt));
          continue;
        }
        return res;
      } catch (err) {
        lastError = err;
        if (!retryable || attempt >= attempts - 1 || !isRetryableError(err)) {
          throw normalizeFetchError(err);
        }
        await sleep(backoffMs(attempt));
      }
    }

    throw normalizeFetchError(lastError);
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function fetchOnce(
  url: URL,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (controller.signal.aborted) {
      throw new RequestTimeoutError(timeoutMs);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function isRetryableError(err: unknown): boolean {
  if (err instanceof RequestTimeoutError) return true;
  if (!(err instanceof Error)) return false;
  return /fetch failed|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT/i.test(
    err.message,
  );
}

function normalizeFetchError(err: unknown): Error {
  if (err instanceof RequestTimeoutError) return err;
  if (err instanceof Error) return new RequestNetworkError(err.message);
  return new RequestNetworkError(String(err));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffMs(attempt: number): number {
  return 250 * 2 ** attempt;
}

function clampInt(
  value: number | undefined,
  min: number,
  max: number,
  fallback: number,
): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function formatMs(ms: number): string {
  return ms % 1000 === 0 ? `${ms / 1000}s` : `${ms}ms`;
}
