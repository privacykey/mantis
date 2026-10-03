import { win32 } from "node:path";

// Where each Windows helper the CLI launches lives, relative to System32.
const SYSTEM32_PATHS = {
  schtasks: "schtasks.exe",
  "rundll32.exe": "rundll32.exe",
  "powershell.exe": win32.join("WindowsPowerShell", "v1.0", "powershell.exe"),
} as const;

export type SystemExe = keyof typeof SYSTEM32_PATHS;

/**
 * The command to spawn for a Windows system helper.
 *
 * Given a bare name, the Windows executable search may try the current
 * directory ahead of PATH, so a same-named file in whatever directory mantis
 * is run from (a cloned repo, an extracted archive, a shared folder) could be
 * launched instead of the real tool. These helpers ship with Windows under
 * %SystemRoot%\System32, so on win32 they are named by absolute path and no
 * search happens at all. Every other platform gets the name back unchanged.
 *
 * Tools that are not part of Windows (cloudflared, git, npm) have no fixed
 * location and are still launched by name.
 */
export function systemExe(
  name: SystemExe,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (platform !== "win32") return name;
  const root = env.SystemRoot || env.windir || "C:\\Windows";
  return win32.join(root, "System32", SYSTEM32_PATHS[name]);
}
