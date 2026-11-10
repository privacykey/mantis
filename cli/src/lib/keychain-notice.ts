import { c, truncate } from "./out.js";

function keychainLabel(): string {
  if (process.platform === "darwin") return "the macOS Keychain";
  if (process.platform === "win32") return "Windows Credential Manager";
  return "your OS keyring";
}

let plainNoticeShown = false;

/**
 * Explain the OS credential prompt while it can be on screen, and only then.
 *
 * A keychain read blocks until the OS has released the credential, which is
 * instant unless the system is asking the user for permission. So the notice
 * is written as one line just before the read and erased right after it: on
 * the usual instant read nobody sees it, and when a system prompt is up it
 * sits in the terminal for exactly as long as the prompt does. Without it the
 * popup looks like phishing.
 *
 * Returns the function that erases the notice (call it once the keychain
 * call has returned), or undefined when nothing was printed: not a terminal,
 * or MANTIS_QUIET=1.
 */
export function maybeEmitKeychainNotice(): (() => void) | undefined {
  if (!process.stderr.isTTY) return undefined;
  if (process.env.MANTIS_QUIET === "1") return undefined;
  const text = `Reading credentials from ${keychainLabel()}. If the system asks, choose "Always Allow".`;
  if (process.env.TERM === "dumb") {
    // No cursor control to erase with: say it once per run and leave it.
    if (!plainNoticeShown) {
      plainNoticeShown = true;
      process.stderr.write(`${text}\n`);
    }
    return undefined;
  }
  // One line, never wrapped, so a single erase removes all of it.
  const width = Math.max(20, (process.stderr.columns ?? 80) - 1);
  process.stderr.write(c.dim(truncate(text, width)));
  return () => {
    process.stderr.write("\r\x1b[2K");
  };
}
