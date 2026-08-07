import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { c, ExitCode, fail, isJsonMode, isQuiet } from "./out.js";
import { canPrompt, createPrompter } from "./prompt.js";

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

/**
 * Write the bundle's file map under `dir`, marking the two bootstrap scripts
 * executable. Paths come from our own bundle builder, but they still end up in
 * join() — refuse anything that would land outside the target directory.
 */
export async function writeBundleTo(
  dir: string,
  bundle: LocalBundleFiles,
): Promise<void> {
  for (const [rel, content] of Object.entries(bundle.files)) {
    const dest = join(dir, rel);
    if (!dest.startsWith(dir)) {
      fail(`refusing to write outside the bundle directory: ${rel}`);
    }
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, content);
  }
  for (const script of [bundle.installScript, bundle.uninstallScript]) {
    await chmod(join(dir, script), 0o755).catch(() => {});
  }
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
  const dir = await mkdtemp(join(tmpdir(), "mantis-device-"));
  await writeBundleTo(dir, bundle);
  const script = join(dir, bundle.installScript);

  if (!isQuiet() && !isJsonMode()) {
    process.stderr.write(
      `\n${c.bold("About to change this machine.")}\n` +
        `Staged at ${c.cyan(dir)} — read ${c.cyan(bundle.installScript)} before continuing.\n`,
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
      const answer = await prompter.ask(
        `Run ${bundle.installScript} now? [y/N] `,
      );
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
    fail(
      `installer exited with code ${code}. Files are at ${dir} for inspection.`,
      ExitCode.Generic,
    );
  }
  return true;
}

function run(script: string, cwd: string): Promise<number> {
  const [cmd, args] = script.endsWith(".ps1")
    ? ["powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script]]
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
