import { hostname } from "node:os";
import { readdir } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import {
  ALL_DEVICE_OS,
  defaultVectorSlugs,
  deviceMemo,
  deviceNameError,
  getDeviceProfile,
  isDeviceOs,
  type DeviceOs,
  type DeviceProfile,
  type DeviceVector,
} from "@mantis/core/device-profiles";
import {
  buildDeviceBundleFiles,
  type BundleVector,
} from "@mantis/core/device-bundle-files";
import { buildInstaller } from "@mantis/core/installers";
import { EDGE_CHANNELS, type EdgeChannel } from "../lib/channels.js";
import { getCurrentProfileName, getProfile } from "../lib/config.js";
import { b64urlEncode, seal } from "../lib/edge-crypto.js";
import { getEdgeKey } from "../lib/edge-key.js";
import {
  applyBundleLocally,
  assertBundleInstallableHere,
  writeBundleTo,
} from "../lib/device-install.js";
import { c, emit, ExitCode, fail } from "../lib/out.js";
import { URL_RE } from "../lib/wizard.js";
import {
  decodeKey,
  deriveKeyIdFromUrl,
  normalizeWorker,
} from "./edge.js";

export type EdgeDeviceOpts = {
  os?: string;
  name?: string;
  vectors?: string;
  all?: boolean;
  bundle?: string;
  install?: boolean;
  yes?: boolean;
  dryRun?: boolean;
  worker?: string;
  webhook?: string;
  channel?: string;
  /** --edge-key: overrides the stored AES key for this mint. */
  key?: string;
  profile?: string;
};

/**
 * `mantis edge device` — the stateless counterpart of `mantis device new`:
 * resolve the OS profile from @mantis/core (no server fetch), mint one edge
 * URL per host alarm, and write the install bundle as a plain DIRECTORY
 * (the CLI ships no zip library; a zip is only ever a convenience over this).
 *
 * Two server-backed properties deliberately do NOT transfer, and the output
 * says so rather than letting them be silent surprises:
 *
 *   - Idempotency. The server dedupes re-mints through the external_id
 *     unique constraint; a stateless worker has no database, so re-running
 *     this command mints a FRESH set of URLs (the old ones keep working
 *     until the worker key rotates).
 *   - Dedupe windows. The network-attach vector gets a 60s window
 *     server-side because Wi-Fi roams burst; the worker can't remember the
 *     last hit, so that vector is chattier on edge.
 */
export async function edgeDeviceCmd(opts: EdgeDeviceOpts): Promise<void> {
  const os = resolveOs(opts);
  const profile = getDeviceProfile(os);
  const device = resolveDeviceName(opts);
  const vectors = resolveVectors(profile, opts);
  if (opts.install) assertBundleInstallableHere(os);

  if (opts.dryRun) {
    emit(
      () => {
        process.stderr.write(
          `${c.bold(device)} (${os}) — ${vectors.length} alarm(s), nothing minted:\n`,
        );
        for (const v of vectors) {
          process.stderr.write(
            `  ${c.cyan(v.slug.padEnd(14))} ${v.label}${v.needsRoot ? c.dim(" [root]") : ""}\n`,
          );
        }
      },
      { device, os, vectors: vectors.map((v) => v.slug) },
    );
    return;
  }

  // Worker / key / webhook — same resolution chain as `mantis edge mint`.
  if (!opts.worker) {
    const profileName = opts.profile ?? (await getCurrentProfileName());
    if (profileName) {
      const cliProfile = await getProfile(profileName);
      if (cliProfile?.edgeWorkerUrl) opts.worker = cliProfile.edgeWorkerUrl;
    }
  }
  if (!opts.worker || !URL_RE.test(opts.worker)) {
    fail(
      "--worker <url> is required (https://…). Set a default with `mantis profile set-edge <name> --worker <url>`.",
    );
  }
  if (!opts.webhook || !URL_RE.test(opts.webhook)) {
    fail(
      "--webhook <url> is required (https://…) — every stateless URL embeds its notification destination",
    );
  }
  if (
    opts.channel &&
    opts.channel !== "webhook" &&
    !(EDGE_CHANNELS as readonly string[]).includes(opts.channel)
  ) {
    fail(
      `invalid --channel: ${opts.channel}. Allowed: ${EDGE_CHANNELS.join(", ")}`,
    );
  }

  const workerUrl = normalizeWorker(opts.worker);
  const keyStr = opts.key ?? getEdgeKey(workerUrl);
  if (!keyStr) {
    fail(
      `no edge key for ${workerUrl}. Run \`mantis edge set-key ${workerUrl}\` or pass --edge-key.`,
    );
  }
  const keyRaw = decodeKey(keyStr);

  // One URL per vector, so a hit tells you which alarm fired — the same
  // reasoning as the server path, minus the server.
  const minted: Array<{
    vector: DeviceVector;
    memo: string;
    url: string;
    keyId: string;
  }> = [];
  for (const v of vectors) {
    const memo = deviceMemo(device, v);
    const payload: Record<string, unknown> = {
      w: opts.webhook,
      r: v.responseKind,
      m: memo,
    };
    if (opts.channel && opts.channel !== "webhook") {
      payload.c = opts.channel as EdgeChannel;
    }
    const sealed = await seal(JSON.stringify(payload), keyRaw);
    const url = `${workerUrl}/c/${b64urlEncode(sealed)}`;
    minted.push({ vector: v, memo, url, keyId: deriveKeyIdFromUrl(url) });
  }

  const bundle = buildDeviceBundleFiles({
    deviceName: device,
    os,
    vectors: minted.map(
      (m): BundleVector => ({
        vector: m.vector,
        installer: buildInstaller(m.vector.installType, {
          url: m.url,
          keyId: m.keyId,
          memo: m.memo,
        }),
        // No server UUID on edge — the derived short id stands in for both.
        key: { id: m.keyId, publicId: m.keyId, memo: m.memo },
      }),
    ),
  });

  let bundleDir: string | null = null;
  if (opts.bundle) {
    bundleDir = resolvePath(opts.bundle);
    const existing = await readdir(bundleDir).catch(() => null);
    if (existing && existing.length > 0) {
      // Merging fresh URLs into an old bundle leaves stale vector files that
      // still fire — a confusing half-armed mix. Make the operator choose.
      fail(
        `--bundle directory ${bundleDir} already exists and is not empty; remove it or pick another path`,
      );
    }
    await writeBundleTo(bundleDir, bundle);
  }

  let installed = false;
  if (opts.install) {
    installed = await applyBundleLocally(bundle, {
      assumeYes: Boolean(opts.yes),
    });
  }

  const chatty = vectors.filter((v) => v.dedupeWindowSeconds > 0);

  emit(
    () => {
      process.stderr.write(
        `${c.green("✓")} ${c.bold(device)} armed (edge) — ${minted.length} alarm(s)\n`,
      );
      for (const m of minted) {
        process.stderr.write(`  ${c.dim(m.memo)}\n    ${c.cyan(m.url)}\n`);
      }
      if (bundleDir) {
        process.stderr.write(
          `\n${c.green("✓")} bundle → ${c.cyan(bundleDir)}\n`,
        );
      }
      process.stderr.write(
        `\n${c.yellow("not on edge:")} re-running this command mints a FRESH set of URLs — a stateless worker has no database, so it cannot return the existing set for a rebuilt machine. The old URLs keep working until the worker key rotates.\n`,
      );
      for (const v of chatty) {
        process.stderr.write(
          `${c.yellow("not on edge:")} ${v.slug} normally dedupes hits in a ${v.dedupeWindowSeconds}s window server-side; the stateless worker cannot remember the last hit, so expect bursts (e.g. Wi-Fi roams) to notify several times.\n`,
        );
      }
      if (!opts.install && !bundleDir) {
        process.stderr.write(
          `\n${c.dim("Nothing installed. Re-run with --bundle <dir> for an install directory, or --install to apply here.")}\n`,
        );
      }
    },
    {
      device,
      os,
      worker: workerUrl,
      keys: minted.map((m) => ({
        slug: m.vector.slug,
        memo: m.memo,
        url: m.url,
        key_id: m.keyId,
        install_type: m.vector.installType,
      })),
      bundle: bundleDir,
      installed,
      not_on_edge: {
        fresh_urls_on_rerun: true,
        undeduped_vectors: chatty.map((v) => v.slug),
      },
    },
  );
}

/* -------------------------------------------------------------------------- */

function resolveOs(opts: EdgeDeviceOpts): DeviceOs {
  const flag = opts.os;
  if (flag && flag !== "auto") {
    if (!isDeviceOs(flag)) {
      fail(
        `unknown --os "${flag}". Available: ${ALL_DEVICE_OS.join(", ")}`,
        ExitCode.Usage,
      );
    }
    return flag;
  }
  // Guessing is only safe when we're demonstrably on the target machine.
  // Minting a bundle FOR a remote host from a laptop must not silently pick
  // the laptop's OS — same rule as `mantis device new`.
  if (!opts.install && flag !== "auto") {
    fail(
      "--os is required (macos | linux | windows), or pass --os auto to use this machine's",
      ExitCode.Usage,
    );
  }
  const mapped =
    process.platform === "darwin"
      ? "macos"
      : process.platform === "win32"
        ? "windows"
        : process.platform === "linux"
          ? "linux"
          : null;
  if (!mapped) {
    fail(
      `cannot detect OS for platform "${process.platform}" — pass --os`,
      ExitCode.Usage,
    );
  }
  return mapped;
}

function resolveDeviceName(opts: EdgeDeviceOpts): string {
  // Default to this machine's hostname only when --install proves we're on it.
  const raw = opts.name ?? (opts.install ? hostname() : undefined);
  if (!raw) {
    fail("--name is required (the machine these alarms are for)", ExitCode.Usage);
  }
  const name = raw.trim();
  const err = deviceNameError(name);
  if (err) fail(`--name: ${err}`, ExitCode.Usage);
  return name;
}

function resolveVectors(
  profile: DeviceProfile,
  opts: EdgeDeviceOpts,
): DeviceVector[] {
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

  const defaults = defaultVectorSlugs(profile.os);
  return profile.vectors.filter((v) => defaults.includes(v.slug));
}
