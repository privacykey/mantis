import { Entry, findCredentialsAsync } from "@napi-rs/keyring";
import { maybeEmitKeychainNotice } from "./keychain-notice.js";

const KEYCHAIN_SERVICE = "mantis-cli-edge";

export function getEdgeKey(workerUrl: string): string | null {
  const eraseNotice = maybeEmitKeychainNotice();
  try {
    return new Entry(KEYCHAIN_SERVICE, workerUrl).getPassword();
  } catch {
    return null;
  } finally {
    eraseNotice?.();
  }
}

export function setEdgeKey(workerUrl: string, key: string): void {
  const eraseNotice = maybeEmitKeychainNotice();
  try {
    new Entry(KEYCHAIN_SERVICE, workerUrl).setPassword(key);
  } finally {
    eraseNotice?.();
  }
}

export function deleteEdgeKey(workerUrl: string): void {
  const eraseNotice = maybeEmitKeychainNotice();
  try {
    new Entry(KEYCHAIN_SERVICE, workerUrl).deletePassword();
  } catch {
    /* nonexistent entries throw on some platforms; ignore */
  } finally {
    eraseNotice?.();
  }
}

/**
 * Returns every worker URL that has an edge key stored locally. Used by the
 * mint wizard to auto-suggest defaults. Returns an empty array on platforms
 * where keychain enumeration isn't supported (e.g., headless Linux without
 * Secret Service) — callers should treat "empty" as "unknown".
 */
export async function listEdgeKeyWorkers(): Promise<string[]> {
  const eraseNotice = maybeEmitKeychainNotice();
  try {
    const credentials = await findCredentialsAsync(KEYCHAIN_SERVICE);
    return credentials.map((c) => c.account);
  } catch {
    return [];
  } finally {
    eraseNotice?.();
  }
}
