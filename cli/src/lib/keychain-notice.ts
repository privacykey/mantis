import { c, glyph } from "./out.js";

let emitted = false;

function keychainLabel(): string {
  if (process.platform === "darwin") return "the macOS Keychain";
  if (process.platform === "win32") return "Windows Credential Manager";
  return "your OS keyring";
}

/**
 * Print a one-time stderr explainer the first time mantis touches the OS
 * keychain in this process. The goal is to make the system password popup
 * unsurprising — without context users worry it's a phishing prompt. Quiet
 * when not connected to a TTY (scripts), and quiet after the first call in
 * a given process so we don't repeat ourselves across multiple keychain
 * reads in the same command.
 */
export function maybeEmitKeychainNotice(): void {
  if (emitted) return;
  if (!process.stderr.isTTY) return;
  if (process.env.MANTIS_QUIET === "1") return;
  emitted = true;
  process.stderr.write(
    c.dim(
      `${glyph("🔐 ", "")}mantis is reading a stored credential from ${keychainLabel()}. If you see a system password prompt, that's the OS asking your permission to release the credential to mantis-cli — click "Always Allow" once and you won't be prompted again on this machine.`,
    ) + "\n",
  );
}
