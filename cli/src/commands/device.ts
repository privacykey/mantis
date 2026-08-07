import { spawn } from "node:child_process";
import { hostname, tmpdir } from "node:os";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type {
  DeviceProfileMeta,
  DeviceVectorMeta,
  MantisClient,
} from "../lib/api.js";
import { c, emit, ExitCode, fail, isJsonMode, isQuiet } from "../lib/out.js";
import { canPrompt, createPrompter } from "../lib/prompt.js";
import { withClient, type GlobalOpts } from "../lib/runner.js";

export type DeviceNewOpts = GlobalOpts & {
  os?: string;
  name?: string;
  vectors?: string;
  all?: boolean;
  bundle?: string;
  install?: boolean;
  yes?: boolean;
  dryRun?: boolean;
};

/**
 * Mint the full set of host alarms for one machine.
 *
 * Two ways to land them: `--bundle` writes the zip (inert — you read the script
 * before running it), `--install` applies them to THIS machine now. Bundle is
 * the default because it's the reversible one; `--install` touches LaunchAgents,
 * systemd units and scheduled tasks, so it confirms first unless given --yes.
 */
export async function deviceNewCmd(opts: DeviceNewOpts): Promise<void> {
  await withClient(opts, async (client) => {
    const { profiles } = await client.deviceProfiles();
    const profile = resolveProfile(profiles, opts.os, Boolean(opts.install));
    const device = resolveDeviceName(opts);
    const vectors = resolveVectors(profile, opts);

    if (opts.dryRun) {
      emit(
        () => {
          process.stderr.write(
            `${c.bold(device)} (${profile.os}) — ${vectors.length} alarm(s), nothing minted:\n`,
          );
          for (const v of vectors) {
            process.stderr.write(
              `  ${c.cyan(v.slug.padEnd(14))} ${v.label}${v.needs_root ? c.dim(" [root]") : ""}\n`,
            );
          }
        },
        { device, os: profile.os, vectors: vectors.map((v) => v.slug) },
      );
      return;
    }

    // external_id makes this idempotent: re-running for a rebuilt machine
    // returns its existing keys instead of minting a duplicate set.
    const minted: Array<{ id: string; slug: string; memo: string; url: string }> =
      [];
    for (const v of vectors) {
      const memo = `${device} — ${v.label}`;
      const key = await client.createKey({
        memo,
        external_id: externalId(device, profile.os, v.slug),
        response_kind: v.response_kind,
        dedupe_window_seconds: v.dedupe_window_seconds,
      });
      minted.push({ id: key.id, slug: v.slug, memo, url: key.url });
    }

    let bundlePath: string | null = null;
    if (opts.bundle) {
      const { data } = await client.downloadDeviceBundle({
        device,
        os: profile.os,
        vectors: minted.map((m) => ({ id: m.id, slug: m.slug })),
      });
      bundlePath = resolve(opts.bundle);
      await mkdir(dirname(bundlePath), { recursive: true });
      await writeFile(bundlePath, data);
    }

    let installed = false;
    if (opts.install) {
      installed = await runLocalInstall(client, {
        device,
        os: profile.os,
        vectors: minted.map((m) => ({ id: m.id, slug: m.slug })),
        assumeYes: Boolean(opts.yes),
      });
    }

    emit(
      () => {
        process.stderr.write(
          `${c.green("✓")} ${c.bold(device)} armed — ${minted.length} alarm(s)\n`,
        );
        for (const m of minted) {
          process.stderr.write(`  ${c.dim(m.memo)}\n    ${c.cyan(m.url)}\n`);
        }
        if (bundlePath) {
          process.stderr.write(`\n${c.green("✓")} bundle → ${c.cyan(bundlePath)}\n`);
        }
        if (!opts.install && !opts.bundle) {
          process.stderr.write(
            `\n${c.dim("Nothing installed. Re-run with --bundle <path> for a zip, or --install to apply here.")}\n`,
          );
        }
      },
      {
        device,
        os: profile.os,
        keys: minted,
        bundle: bundlePath,
        installed,
      },
    );
  });
}

/** `mantis device profiles` — what each OS would mint. */
export async function deviceProfilesCmd(opts: GlobalOpts): Promise<void> {
  await withClient(opts, async (client) => {
    const { profiles } = await client.deviceProfiles();
    emit(
      () => {
        for (const p of profiles) {
          process.stderr.write(`\n${c.bold(p.label)} ${c.dim(`(${p.os})`)}\n`);
          for (const v of p.vectors) {
            const flags = [
              v.needs_root ? "root" : null,
              v.needs_extra_setup ? `needs ${v.needs_extra_setup.what}` : null,
              p.defaults.includes(v.slug) ? null : "off by default",
            ].filter(Boolean);
            process.stderr.write(
              `  ${c.cyan(v.slug.padEnd(14))} ${v.label}` +
                (flags.length ? c.dim(`  [${flags.join(", ")}]`) : "") +
                `\n      ${c.dim(v.blurb)}\n`,
            );
          }
        }
      },
      profiles,
    );
  });
}

/* -------------------------------------------------------------------------- */

function resolveProfile(
  profiles: DeviceProfileMeta[],
  osOpt: string | undefined,
  installing: boolean,
): DeviceProfileMeta {
  const wanted = osOpt && osOpt !== "auto" ? osOpt : detectOs(installing, osOpt);
  const found = profiles.find((p) => p.os === wanted);
  if (!found) {
    fail(
      `unknown --os "${wanted}". Available: ${profiles.map((p) => p.os).join(", ")}`,
      ExitCode.Usage,
    );
  }
  return found;
}

function detectOs(installing: boolean, osOpt: string | undefined): string {
  const mapped =
    process.platform === "darwin"
      ? "macos"
      : process.platform === "win32"
        ? "windows"
        : process.platform === "linux"
          ? "linux"
          : null;
  // Guessing is only safe when we're demonstrably on the target machine.
  // Minting a bundle FOR a remote host from a laptop must not silently pick
  // the laptop's OS.
  if (!installing && osOpt !== "auto") {
    fail(
      "--os is required (macos | linux | windows), or pass --os auto to use this machine's",
      ExitCode.Usage,
    );
  }
  if (!mapped) {
    fail(`cannot detect OS for platform "${process.platform}" — pass --os`, ExitCode.Usage);
  }
  return mapped;
}

function resolveDeviceName(opts: DeviceNewOpts): string {
  // Same reasoning as OS detection: default to this machine's hostname only
  // when --install proves we're on it.
  const raw = opts.name ?? (opts.install ? hostname() : undefined);
  if (!raw) {
    fail("--name is required (the machine these alarms are for)", ExitCode.Usage);
  }
  const name = raw.trim();
  if (!name) fail("--name cannot be empty", ExitCode.Usage);
  if (name.length > 200) fail("--name too long (max 200)", ExitCode.Usage);
  // Mirrors normalizeDeviceName on the server: a name of pure punctuation
  // normalizes to "", and every such device would then share one externalId.
  if (!name.replace(/[^A-Za-z0-9]+/g, "")) {
    fail("--name needs at least one letter or digit", ExitCode.Usage);
  }
  return name;
}

function resolveVectors(
  profile: DeviceProfileMeta,
  opts: DeviceNewOpts,
): DeviceVectorMeta[] {
  if (opts.vectors && opts.all) {
    fail("--vectors and --all are mutually exclusive", ExitCode.Usage);
  }
  if (opts.all) return profile.vectors;

  if (opts.vectors) {
    const want = opts.vectors
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const unknown = want.filter(
      (s) => !profile.vectors.some((v) => v.slug === s),
    );
    if (unknown.length > 0) {
      fail(
        `unknown vector(s) for ${profile.os}: ${unknown.join(", ")}. Available: ${profile.vectors.map((v) => v.slug).join(", ")}`,
        ExitCode.Usage,
      );
    }
    // Profile order, not argument order, so the bundle reads consistently.
    return profile.vectors.filter((v) => want.includes(v.slug));
  }

  return profile.vectors.filter((v) => profile.defaults.includes(v.slug));
}

/** Server-side format is `mantis:device:<os>:<normalized name>:<slug>`. */
function externalId(device: string, os: string, slug: string): string {
  const normalized = device
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return `mantis:device:${os}:${normalized}:${slug}`;
}

/* -------------------------------------------------------------------------- */

/**
 * Materialize the bundle into a temp directory and run its bootstrap.
 *
 * Deliberately NOT a reimplementation of the install recipes: the script is the
 * one the zip ships and the one the tests cover. The CLI's job is to lay the
 * files out and hand over.
 */
async function runLocalInstall(
  client: MantisClient,
  input: {
    device: string;
    os: string;
    vectors: Array<{ id: string; slug: string }>;
    assumeYes: boolean;
  },
): Promise<boolean> {
  if (input.os === "windows" && process.platform !== "win32") {
    fail(
      "--install can only apply a windows profile on Windows; use --bundle and copy it across",
      ExitCode.Usage,
    );
  }
  if (input.os !== "windows" && process.platform === "win32") {
    fail(
      `--install can only apply a ${input.os} profile on ${input.os}; use --bundle and copy it across`,
      ExitCode.Usage,
    );
  }

  const bundle = await client.deviceBundleFiles({
    device: input.device,
    os: input.os,
    vectors: input.vectors,
  });

  const dir = await mkdtemp(join(tmpdir(), "mantis-device-"));
  for (const [rel, content] of Object.entries(bundle.files)) {
    const dest = join(dir, rel);
    // Paths come from our own server, but they still end up in join() — refuse
    // anything that would land outside the temp directory.
    if (!dest.startsWith(dir)) {
      fail(`refusing to write outside the staging directory: ${rel}`);
    }
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, content);
  }
  const script = join(dir, bundle.installScript);
  await chmod(script, 0o755).catch(() => {});

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
