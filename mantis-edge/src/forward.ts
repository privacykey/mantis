import { parseHostContext } from "./host-context";
import type { Payload } from "./types";

const SEND_TIMEOUT_MS = 5000;

export async function forward(payload: Payload, req: Request): Promise<void> {
  const headers = snapshotHeaders(req.headers);
  const now = new Date().toISOString();

  const body = {
    type: "mantis.hit",
    key: {
      id: null,
      public_id: null,
      memo: payload.m ?? null,
      url: req.url,
    },
    hit: {
      id: crypto.randomUUID(),
      occurred_at: now,
      ip: req.headers.get("cf-connecting-ip") ?? null,
      user_agent: req.headers.get("user-agent") ?? null,
      referer: req.headers.get("referer") ?? null,
      ua_browser: null,
      ua_browser_version: null,
      ua_os: null,
      ua_device: null,
      bot_label: null,
      is_duplicate: false,
      host_context: parseHostContext(headers),
      headers,
    },
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
  try {
    const res = await fetch(payload.w, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "mantis-edge-webhook/0.1",
      },
      body: JSON.stringify(body),
      redirect: "manual",
      signal: controller.signal,
    });
    if (res.status >= 300 && res.status < 400) {
      throw new Error(`HTTP ${res.status} redirect refused`);
    }
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

function snapshotHeaders(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((v, k) => {
    out[k] = v;
  });
  return out;
}
