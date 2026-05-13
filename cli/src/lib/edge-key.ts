import { Entry } from "@napi-rs/keyring";

const KEYCHAIN_SERVICE = "mantis-cli-edge";

export function getEdgeKey(workerUrl: string): string | null {
  try {
    return new Entry(KEYCHAIN_SERVICE, workerUrl).getPassword();
  } catch {
    return null;
  }
}

export function setEdgeKey(workerUrl: string, key: string): void {
  new Entry(KEYCHAIN_SERVICE, workerUrl).setPassword(key);
}

export function deleteEdgeKey(workerUrl: string): void {
  try {
    new Entry(KEYCHAIN_SERVICE, workerUrl).deletePassword();
  } catch {
    /* nonexistent entries throw on some platforms; ignore */
  }
}
