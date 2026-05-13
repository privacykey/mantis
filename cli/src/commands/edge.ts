import { randomBytes } from "node:crypto";
import { getCurrentProfileName, getProfile } from "../lib/config.js";
import { b64urlDecode, b64urlEncode, seal } from "../lib/edge-crypto.js";
import { copyToClipboard } from "../lib/clipboard.js";
import {
  deleteEdgeKey,
  getEdgeKey,
  setEdgeKey,
} from "../lib/edge-key.js";
import { c, emit, fail } from "../lib/out.js";

const URL_RE = /^https?:\/\/.+/;
const RESPONSE_KINDS = ["gif", "empty", "json", "redirect", "html"] as const;
type ResponseKind = (typeof RESPONSE_KINDS)[number];

function normalizeWorker(url: string): string {
  return url.replace(/\/$/, "");
}

function decodeKey(keyStr: string): Uint8Array {
  let raw: Uint8Array;
  try {
    raw = b64urlDecode(keyStr);
  } catch {
    fail("key is not valid base64url");
  }
  if (raw.length !== 32) {
    fail(`key must decode to 32 bytes, got ${raw.length}`);
  }
  return raw;
}

export function keygenCmd(): void {
  const key = b64urlEncode(new Uint8Array(randomBytes(32)));
  emit(
    () => {
      process.stdout.write(key + "\n");
      process.stderr.write(
        `\n${c.dim("# Set on the worker:")}\n` +
          `  cd mantis-edge && wrangler secret put MANTIS_EDGE_KEY\n` +
          `  ${c.dim("# paste the value above when prompted")}\n\n` +
          `${c.dim("# Save locally for minting:")}\n` +
          `  mantis edge set-key --worker <worker-url> --key ${c.dim("<paste>")}\n`,
      );
    },
    { key },
  );
}

export function setKeyCmd(opts: { worker?: string; key?: string }): void {
  const worker = opts.worker;
  const key = opts.key;
  if (!worker || !URL_RE.test(worker)) {
    fail("--worker <url> is required (https://…)");
  }
  if (!key) {
    fail("--key <base64url> is required");
  }
  decodeKey(key);
  const workerUrl = normalizeWorker(worker);
  setEdgeKey(workerUrl, key);
  emit(
    () => {
      process.stderr.write(
        `${c.green("✓")} stored edge key for ${c.cyan(workerUrl)}\n`,
      );
    },
    { worker: workerUrl, stored: true },
  );
}

export function deleteKeyCmd(opts: { worker?: string }): void {
  const worker = opts.worker;
  if (!worker || !URL_RE.test(worker)) {
    fail("--worker <url> is required");
  }
  const workerUrl = normalizeWorker(worker);
  deleteEdgeKey(workerUrl);
  emit(
    () => {
      process.stderr.write(
        `${c.green("✓")} cleared edge key for ${c.cyan(workerUrl)}\n`,
      );
    },
    { worker: workerUrl, deleted: true },
  );
}

export async function mintCmd(opts: {
  worker?: string;
  webhook?: string;
  responseKind?: string;
  responsePayload?: string;
  memo?: string;
  expiresAt?: string;
  key?: string;
  profile?: string;
  copy?: boolean;
}): Promise<void> {
  let worker = opts.worker;
  if (!worker) {
    // Fall back to the profile's default edge worker.
    const profileName =
      opts.profile ?? (await getCurrentProfileName());
    if (profileName) {
      const profile = await getProfile(profileName);
      if (profile?.edgeWorkerUrl) worker = profile.edgeWorkerUrl;
    }
  }
  const webhook = opts.webhook;
  if (!worker || !URL_RE.test(worker)) {
    fail(
      "--worker <url> is required (https://…). Set a default with `mantis profile set-edge <name> --worker <url>`.",
    );
  }
  if (!webhook || !URL_RE.test(webhook)) {
    fail("--webhook <url> is required (https://…)");
  }

  const workerUrl = normalizeWorker(worker);
  const keyStr = opts.key ?? getEdgeKey(workerUrl);
  if (!keyStr) {
    fail(
      `no edge key for ${workerUrl}. Run \`mantis edge set-key --worker ${workerUrl} --key <key>\` or pass --key.`,
    );
  }
  const keyRaw = decodeKey(keyStr);

  const payload: Record<string, unknown> = { w: webhook };

  if (opts.responseKind) {
    if (!(RESPONSE_KINDS as readonly string[]).includes(opts.responseKind)) {
      fail(
        `invalid --response-kind: ${opts.responseKind}. Allowed: ${RESPONSE_KINDS.join(", ")}`,
      );
    }
    payload.r = opts.responseKind as ResponseKind;
  }

  if (opts.responsePayload) {
    try {
      payload.p = JSON.parse(opts.responsePayload);
    } catch {
      fail("--response-payload is not valid JSON");
    }
  }

  if (opts.memo) payload.m = opts.memo;

  let expIso: string | null = null;
  if (opts.expiresAt) {
    const t = Date.parse(opts.expiresAt);
    if (Number.isNaN(t)) {
      fail(`--expires-at is not a valid ISO date: ${opts.expiresAt}`);
    }
    payload.exp = Math.floor(t / 1000);
    expIso = new Date(t).toISOString();
  }

  const sealed = await seal(JSON.stringify(payload), keyRaw);
  const blob = b64urlEncode(sealed);
  const url = `${workerUrl}/c/${blob}`;
  const copied = opts.copy ? await copyToClipboard(url) : null;

  emit(
    () => {
      process.stdout.write(url + "\n");
      process.stderr.write(
        `${c.dim("length:")} ${url.length}` +
          (expIso ? `  ${c.dim("expires:")} ${expIso}` : "") +
          "\n",
      );
      if (copied !== null) {
        process.stderr.write(
          copied
            ? `${c.dim("copy:")} copied URL to clipboard\n`
            : `${c.yellow("copy:")} clipboard command not available\n`,
        );
      }
    },
    {
      url,
      length: url.length,
      expires_at: expIso,
      ...(copied !== null ? { copied } : {}),
    },
  );
}
