import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { c, ExitCode, fail, isJsonMode, isQuiet, safeText } from "./out.js";
import { canPrompt, createPrompter } from "./prompt.js";
import { systemExe } from "./system-exe.js";

/**
 * Materializing and running a device bundle locally, shared by
 * `mantis device new --install` (bundle fetched from the server) and
 * `mantis edge device --install` (bundle built locally from @mantis/core).
 * One implementation so the two paths cannot drift in how they stage files,
 * confirm, and hand over to the bootstrap script.
 */

/**
 * The subset of a device bundle this module needs. Matches both the server's
 * `?format=json` response (DeviceBundleFiles in lib/api.ts) and core's
 * BundleFiles.
 */
export type LocalBundleFiles = {
  installScript: string;
  uninstallScript: string;
  files: Record<string, string>;
};

/** `--install` only makes sense when the profile matches this machine. */
export function assertBundleInstallableHere(os: string): void {
  if (os === "windows" && process.platform !== "win32") {
    fail(
      "--install can only apply a windows profile on Windows; use --bundle and copy it across",
      ExitCode.Usage,
    );
  }
  if (os !== "windows" && process.platform === "win32") {
    fail(
      `--install can only apply a ${os} profile on ${os}; use --bundle and copy it across`,
      ExitCode.Usage,
    );
  }
}

/** A bundle whose every path has been checked; see planBundle(). */
type BundlePlan = {
  /** Paths are relative to the bundle directory and cannot leave it. */
  files: Array<{ rel: string; content: string }>;
  installScript: string;
  uninstallScript: string;
};

// Containment only depends on how a path resolves against *some* absolute
// directory, so the check can run before the real one exists.
const PLAN_ROOT = resolve(tmpdir(), "mantis-bundle");

/** One bundle path, normalized; refuses anything absolute or outside the bundle. */
function bundlePath(rel: unknown, what: string): string {
  const shown = safeText(typeof rel === "string" ? rel : String(rel));
  if (
    typeof rel !== "string" ||
    rel.length === 0 ||
    /[\u0000-\u001f\u007f]/.test(rel) ||
    isAbsolute(rel)
  ) {
    throw new Error(
      `refusing the device bundle: ${what} is not a plain relative path: ${shown}`,
    );
  }
  const inside = relative(PLAN_ROOT, resolve(PLAN_ROOT, rel));
  if (
    !inside ||
    inside === ".." ||
    inside.startsWith(`..${sep}`) ||
    isAbsolute(inside)
  ) {
    throw new Error(
      `refusing the device bundle: ${what} points outside the bundle directory: ${shown}`,
    );
  }
  return inside;
}

/**
 * Check a whole bundle before anything touches the disk.
 *
 * For `device new --install` the bundle is an HTTP response, and every path in
 * it ends up in a write, a chmod or an exec. So each file path — and both
 * script names, which must be files the bundle itself ships — has to be a
 * relative path that stays inside the bundle directory. A bundle that fails
 * any check is refused as a whole: nothing is created, written or chmod-ed.
 */
function planBundle(bundle: LocalBundleFiles): BundlePlan {
  const map: unknown = bundle?.files;
  if (typeof map !== "object" || map === null || Array.isArray(map)) {
    throw new Error("refusing the device bundle: it has no file map");
  }

  const files: BundlePlan["files"] = [];
  const taken = new Set<string>();
  for (const [key, content] of Object.entries(map)) {
    const rel = bundlePath(key, "a file path");
    if (typeof content !== "string") {
      throw new Error(
        `refusing the device bundle: ${safeText(key)} has no text content`,
      );
    }
    // Compared case-insensitively: two paths that differ only by case are
    // one file on the default macOS and Windows filesystems.
    const folded = rel.toLowerCase();
    if (taken.has(folded)) {
      throw new Error(
        `refusing the device bundle: ${safeText(key)} is listed more than once`,
      );
    }
    taken.add(folded);
    files.push({ rel, content });
  }
  for (const { rel } of files) {
    for (let dir = dirname(rel); dir !== "."; dir = dirname(dir)) {
      if (taken.has(dir.toLowerCase())) {
        throw new Error(
          `refusing the device bundle: ${safeText(dir)} is both a file and a directory`,
        );
      }
    }
  }

  const script = (name: unknown, what: string): string => {
    if (typeof name !== "string" || !Object.hasOwn(map, name)) {
      throw new Error(
        `refusing the device bundle: ${what} is not one of the bundle's own files: ${safeText(String(name))}`,
      );
    }
    return bundlePath(name, what);
  };
  return {
    files,
    installScript: script(bundle.installScript, "the install script"),
    uninstallScript: script(bundle.uninstallScript, "the uninstall script"),
  };
}

async function writePlan(dir: string, plan: BundlePlan): Promise<void> {
  const root = resolve(dir);
  for (const { rel, content } of plan.files) {
    const dest = join(root, rel);
    await mkdir(dirname(dest), { recursive: true });
    // Exclusive create: a staged file is always new, never written through
    // something that was already at that path.
    await writeFile(dest, content, { flag: "wx" });
  }
  for (const rel of [plan.installScript, plan.uninstallScript]) {
    // Best-effort (some filesystems have no mode bits); run() starts the
    // script through its interpreter, so the bit is a convenience for anyone
    // running the staged bundle by hand.
    await chmod(join(root, rel), 0o755).catch(() => {});
  }
}

/**
 * Write the bundle's file map under `dir`, marking the two bootstrap scripts
 * executable. The whole bundle is validated first (see planBundle), so a
 * bundle with a bad path writes nothing at all.
 */
export async function writeBundleTo(
  dir: string,
  bundle: LocalBundleFiles,
): Promise<void> {
  await writePlan(dir, planBundle(bundle));
}

/**
 * Materialize the bundle into a temp directory and run its bootstrap.
 *
 * Deliberately NOT a reimplementation of the install recipes: the script is the
 * one the bundle ships and the one the tests cover. The CLI's job is to lay the
 * files out and hand over.
 */
export async function applyBundleLocally(
  bundle: LocalBundleFiles,
  input: { assumeYes: boolean },
): Promise<boolean> {
  // Validate before staging: until the operator confirms, the only thing this
  // may change is the fresh staging directory.
  const plan = planBundle(bundle);
  const dir = await mkdtemp(join(tmpdir(), "mantis-device-"));
  await writePlan(dir, plan);
  const script = join(dir, plan.installScript);
  const scriptName = safeText(plan.installScript);

  if (!isQuiet() && !isJsonMode()) {
    process.stderr.write(
      `\n${c.bold("About to change this machine.")}\n` +
        `Staged at ${c.cyan(dir)} — read ${c.cyan(scriptName)} before continuing.\n`,
    );
  }

  if (!input.assumeYes) {
    if (!canPrompt()) {
      fail(
        "--install needs a TTY to confirm. Pass --yes to run unattended, or use --bundle.",
        ExitCode.Usage,
      );
    }
    const prompter = createPrompter();
    try {
      const answer = await prompter.ask(`Run ${scriptName} now? [y/N] `);
      if (!/^y(es)?$/i.test(answer)) {
        process.stderr.write(
          `aborted. The bundle is still at ${dir} if you want to run it by hand.\n`,
        );
        return false;
      }
    } finally {
      prompter.close();
    }
  }

  // The script does its own per-vector confirmation; we've already taken one
  // here, so don't ask twice.
  const code = await run(script, dir);
  if (code !== 0) {
    throw new Error(
      `installer exited with code ${code}. Files are at ${dir} for inspection.`,
    );
  }
  return true;
}

function run(script: string, cwd: string): Promise<number> {
  const [cmd, args] = script.endsWith(".ps1")
    ? [
        systemExe("powershell.exe"),
        ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script],
      ]
    : ["/bin/sh", [script]];
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(cmd as string, args as string[], {
      cwd,
      stdio: "inherit",
      env: { ...process.env, MANTIS_ASSUME_YES: "1" },
    });
    child.on("error", rejectPromise);
    child.on("close", (code) => resolvePromise(code ?? 1));
  });
}
