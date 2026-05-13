/**
 * Bench setup helpers.
 *
 * Mints fresh sealed mantis-edge URLs (without the CLI binary in the loop)
 * and spawns a tiny HTTP listener that captures forwarded webhooks.
 *
 * Mirror of cli/src/lib/edge-crypto.ts — kept tiny so we don't pull TS or the
 * CLI build into the bench.
 */
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { Buffer } from "node:buffer";
import { webcrypto } from "node:crypto";

const SEAL_VERSION = 0x01;
const NONCE_LEN = 12;

/** AES-GCM seal — matches cli/src/lib/edge-crypto.ts:seal. */
export async function seal(plaintext, keyRaw) {
  const key = await webcrypto.subtle.importKey(
    "raw",
    keyRaw,
    { name: "AES-GCM" },
    false,
    ["encrypt"],
  );
  const nonce = webcrypto.getRandomValues(new Uint8Array(NONCE_LEN));
  const ctTag = new Uint8Array(
    await webcrypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce },
      key,
      new TextEncoder().encode(plaintext),
    ),
  );
  const out = new Uint8Array(1 + NONCE_LEN + ctTag.length);
  out[0] = SEAL_VERSION;
  out.set(nonce, 1);
  out.set(ctTag, 1 + NONCE_LEN);
  return out;
}

export function b64urlEncode(bytes) {
  return Buffer.from(bytes).toString("base64url");
}

/**
 * Resolve the AES key the bench should seal with. Priority:
 *   1. MANTIS_EDGE_KEY env var (preferred for CI)
 *   2. mantis-edge/.dev.vars MANTIS_EDGE_KEY=...
 * Both must be 32 bytes base64url-encoded.
 */
export function resolveEdgeKey() {
  const envKey = process.env.MANTIS_EDGE_KEY;
  if (envKey) return decodeEdgeKey(envKey);
  const devVars = resolvePath(
    new URL(".", import.meta.url).pathname,
    "../../mantis-edge/.dev.vars",
  );
  if (existsSync(devVars)) {
    const raw = readFileSync(devVars, "utf8");
    const m = /^\s*MANTIS_EDGE_KEY\s*=\s*(\S+)/m.exec(raw);
    if (m) return decodeEdgeKey(m[1]);
  }
  throw new Error(
    "no MANTIS_EDGE_KEY available. Set the env var, or put MANTIS_EDGE_KEY=… in mantis-edge/.dev.vars",
  );
}

function decodeEdgeKey(b64url) {
  const raw = Buffer.from(b64url, "base64url");
  if (raw.length !== 32) {
    throw new Error(
      `MANTIS_EDGE_KEY must decode to 32 bytes, got ${raw.length}`,
    );
  }
  return new Uint8Array(raw);
}

/**
 * Build a sealed `/c/<blob>` URL for the given worker.
 *   payload: minimum { w: webhook }, optional r/p/m/exp.
 */
export async function mintEdgeUrl({
  workerUrl,
  webhook,
  responseKind,
  responsePayload,
  memo,
  expiresAt,
  keyRaw,
}) {
  const payload = { w: webhook };
  if (responseKind) payload.r = responseKind;
  if (responsePayload !== undefined) payload.p = responsePayload;
  if (memo) payload.m = memo;
  if (expiresAt) payload.exp = expiresAt;
  const sealed = await seal(JSON.stringify(payload), keyRaw);
  const blob = b64urlEncode(sealed);
  return `${workerUrl.replace(/\/$/, "")}/c/${blob}`;
}

/**
 * Spawn a tiny HTTP server that 200s every POST. Hands back its URL plus a
 * counter you can read at teardown.
 */
export function startWebhookListener({ port = 0 } = {}) {
  let received = 0;
  let totalBytes = 0;
  const server = createServer((req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    let length = 0;
    req.on("data", (chunk) => {
      length += chunk.length;
    });
    req.on("end", () => {
      received += 1;
      totalBytes += length;
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
    });
  });
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address();
      const realPort = typeof addr === "object" && addr ? addr.port : port;
      resolve({
        url: `http://127.0.0.1:${realPort}/wh`,
        counts: () => ({ received, totalBytes }),
        close: () =>
          new Promise((r) => {
            server.close(() => r());
          }),
      });
    });
  });
}

/** Probe a worker URL once to verify wrangler dev is up. */
export async function probeWorker(workerUrl) {
  try {
    const res = await fetch(`${workerUrl.replace(/\/$/, "")}/c/invalid-blob`, {
      method: "GET",
    });
    return res.status === 404;
  } catch {
    return false;
  }
}
