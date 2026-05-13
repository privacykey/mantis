const VERSION = 0x01;
const NONCE_LEN = 12;
const TAG_LEN = 16;
const MIN_LEN = 1 + NONCE_LEN + TAG_LEN;

export async function seal(
  plaintext: Uint8Array,
  keyRaw: Uint8Array,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    keyRaw as BufferSource,
    { name: "AES-GCM" },
    false,
    ["encrypt"],
  );
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_LEN));
  const ctTag = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce },
      key,
      plaintext as BufferSource,
    ),
  );
  const out = new Uint8Array(1 + NONCE_LEN + ctTag.length);
  out[0] = VERSION;
  out.set(nonce, 1);
  out.set(ctTag, 1 + NONCE_LEN);
  return out;
}

export async function unseal(
  sealed: Uint8Array,
  keyRaw: Uint8Array,
): Promise<Uint8Array> {
  if (sealed.length < MIN_LEN) throw new Error("too short");
  if (sealed[0] !== VERSION) throw new Error("bad version");
  // .slice() (not .subarray()) so the returned Uint8Arrays are backed by
  // ArrayBuffer, not ArrayBufferLike — Web Crypto's BufferSource demands that.
  const nonce = sealed.slice(1, 1 + NONCE_LEN);
  const ct = sealed.slice(1 + NONCE_LEN);
  const key = await crypto.subtle.importKey(
    "raw",
    keyRaw as BufferSource,
    { name: "AES-GCM" },
    false,
    ["decrypt"],
  );
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: nonce },
    key,
    ct as BufferSource,
  );
  return new Uint8Array(pt);
}

export function b64urlEncode(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlDecode(str: string): Uint8Array {
  const b64 = str.replace(/-/g, "+").replace(/_/g, "/");
  const pad = (4 - (b64.length % 4)) % 4;
  const bin = atob(b64 + "=".repeat(pad));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
