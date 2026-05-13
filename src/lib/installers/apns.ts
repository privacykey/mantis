import { createSign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { connect, type ClientHttp2Session } from "node:http2";
import { log } from "@/lib/log";
import { loadActiveWalletConfig } from "./wallet-store";

const APNS_HOST_PROD = "https://api.push.apple.com";
const APNS_HOST_DEV = "https://api.development.push.apple.com";

const JWT_TTL_MS = 50 * 60_000; // refresh under Apple's 1h max
const REQUEST_TIMEOUT_MS = 5_000;

let cachedJwt: { token: string; expiresAt: number; teamId: string; keyId: string } | null = null;

type ApnsConfig = {
  keyPem: Buffer;
  keyId: string;
  teamId: string;
  passTypeId: string;
  host: string;
};

async function loadApnsConfig(): Promise<ApnsConfig | null> {
  const cfg = await loadActiveWalletConfig();
  if (!cfg) return null;
  // APNs config is currently only env-driven. (DB-stored .p8 is a follow-up;
  // operators using the dashboard cert path can still set the .p8 via env.)
  const keyPath = process.env.APPLE_PASS_APNS_KEY_PATH;
  const keyId = process.env.APPLE_PASS_APNS_KEY_ID;
  if (!keyPath || !keyId) return null;
  let keyPem: Buffer;
  try {
    keyPem = await readFile(keyPath);
  } catch (err) {
    log.warn({ err, keyPath }, "APNs key file unreadable");
    return null;
  }
  return {
    keyPem,
    keyId,
    teamId: cfg.teamId,
    passTypeId: cfg.passTypeId,
    host:
      process.env.APPLE_PASS_APNS_SANDBOX === "1" ? APNS_HOST_DEV : APNS_HOST_PROD,
  };
}

export async function isApnsEnabled(): Promise<boolean> {
  return (await loadApnsConfig()) !== null;
}

function base64url(buf: Buffer | string): string {
  return Buffer.from(buf).toString("base64url");
}

/**
 * ES256 JWT for APNs token auth.
 * Header: { alg: ES256, kid: <keyId>, typ: JWT }
 * Payload: { iss: <teamId>, iat: <unix> }
 * Signature: ECDSA-SHA256(header.payload, p8 key) → raw r||s (64 bytes), base64url.
 */
function signApnsJwt(cfg: ApnsConfig): string {
  if (
    cachedJwt &&
    cachedJwt.expiresAt > Date.now() &&
    cachedJwt.teamId === cfg.teamId &&
    cachedJwt.keyId === cfg.keyId
  ) {
    return cachedJwt.token;
  }

  const header = base64url(
    JSON.stringify({ alg: "ES256", kid: cfg.keyId, typ: "JWT" }),
  );
  const payload = base64url(
    JSON.stringify({ iss: cfg.teamId, iat: Math.floor(Date.now() / 1000) }),
  );
  const signingInput = `${header}.${payload}`;

  const signer = createSign("SHA256");
  signer.update(signingInput);
  signer.end();
  // Node returns ECDSA signatures in DER by default. APNs needs raw r||s.
  const derSig = signer.sign({ key: cfg.keyPem, dsaEncoding: "ieee-p1363" });
  const sig = base64url(derSig);

  const token = `${signingInput}.${sig}`;
  cachedJwt = {
    token,
    expiresAt: Date.now() + JWT_TTL_MS,
    teamId: cfg.teamId,
    keyId: cfg.keyId,
  };
  return token;
}

export type PushResult = {
  pushToken: string;
  ok: boolean;
  status?: number;
  error?: string;
};

/**
 * Sends an empty-body APNs push (the Wallet update-trigger) to a single
 * device token. Returns a structured result so callers can act on per-device
 * failures (e.g. 410 = unregister the device locally).
 */
async function sendOneApnsPush(
  cfg: ApnsConfig,
  pushToken: string,
  session: ClientHttp2Session,
): Promise<PushResult> {
  return new Promise<PushResult>((resolve) => {
    const stream = session.request({
      ":method": "POST",
      ":path": `/3/device/${pushToken}`,
      "apns-topic": cfg.passTypeId,
      "apns-push-type": "background",
      "apns-priority": "5",
      "apns-expiration": "0",
      authorization: `bearer ${signApnsJwt(cfg)}`,
      "content-type": "application/json",
    });

    let status = 0;
    let body = "";
    const timer = setTimeout(() => {
      try {
        stream.close();
      } catch {
        /* ignore */
      }
      resolve({ pushToken, ok: false, error: "timeout" });
    }, REQUEST_TIMEOUT_MS);

    stream.on("response", (headers) => {
      status = Number(headers[":status"] ?? 0);
    });
    stream.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    stream.on("end", () => {
      clearTimeout(timer);
      if (status === 200) {
        resolve({ pushToken, ok: true, status });
        return;
      }
      let parsed: { reason?: string } = {};
      try {
        parsed = JSON.parse(body);
      } catch {
        /* keep blank */
      }
      resolve({
        pushToken,
        ok: false,
        status,
        error: parsed.reason ?? body.slice(0, 200),
      });
    });
    stream.on("error", (err) => {
      clearTimeout(timer);
      resolve({ pushToken, ok: false, error: err.message });
    });
    stream.end("{}");
  });
}

/**
 * Sends an APNs push to every device registered for a key. Used after the
 * key's memo (or anything pass-affecting) changes — iOS Wallet will fetch
 * the updated pass from /api/wallet/v1/passes/:passTypeId/:serial.
 */
export async function pushPassUpdate(
  pushTokens: string[],
): Promise<PushResult[] | null> {
  if (pushTokens.length === 0) return [];
  const cfg = await loadApnsConfig();
  if (!cfg) return null;

  const session = connect(cfg.host);
  try {
    return await Promise.all(
      pushTokens.map((t) => sendOneApnsPush(cfg, t, session)),
    );
  } finally {
    session.close();
  }
}
