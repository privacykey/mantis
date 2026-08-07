import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import {
  buildDeviceBundle,
  bundleRootName,
  windowsTaskName,
  type BundleVector,
} from "@/lib/device-bundle";
import {
  DEVICE_PROFILES,
  defaultVectorSlugs,
  deviceExternalId,
  deviceMemo,
  getDeviceProfile,
  normalizeDeviceName,
  type DeviceOs,
} from "@/lib/device-profiles";
import { buildInstaller, INSTALLER_META } from "@/lib/installers";

const KEY_ID = "3f7c1a2b-4d5e-6f70-8192-a3b4c5d6e7f8";
const URL = "https://mantis.example.com/c/abc123";

function vectorsFor(os: DeviceOs, slugs?: string[]): BundleVector[] {
  const profile = getDeviceProfile(os);
  const chosen = slugs
    ? profile.vectors.filter((v) => slugs.includes(v.slug))
    : profile.vectors;
  return chosen.map((vector, i) => {
    // Distinct key ids: installers embed a short id, and same-id vectors would
    // hide filename collisions this suite is meant to catch.
    const keyId = `${KEY_ID.slice(0, 35)}${i.toString(16)}`;
    return {
      vector,
      key: { id: keyId, publicId: `pub${i}`, memo: deviceMemo("web01", vector) },
      installer: buildInstaller(vector.installType, {
        url: URL,
        keyId,
        memo: deviceMemo("web01", vector),
      }),
    };
  });
}

async function unzip(buf: Buffer) {
  const zip = await JSZip.loadAsync(buf);
  const files: Record<string, string> = {};
  for (const [path, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue;
    files[path] = await entry.async("string");
  }
  return files;
}

describe("device profiles", () => {
  it("references only install types that exist", () => {
    for (const profile of DEVICE_PROFILES) {
      for (const v of profile.vectors) {
        expect(
          INSTALLER_META[v.installType],
          `${profile.os}/${v.slug} → ${v.installType}`,
        ).toBeTruthy();
      }
    }
  });

  it("uses install types whose OS matches the profile (or posix)", () => {
    for (const profile of DEVICE_PROFILES) {
      for (const v of profile.vectors) {
        const os = INSTALLER_META[v.installType].os;
        expect(
          [profile.os, "posix"],
          `${profile.os}/${v.slug} is an ${os} installer`,
        ).toContain(os);
      }
    }
  });

  it("has unique slugs within a profile", () => {
    for (const profile of DEVICE_PROFILES) {
      const slugs = profile.vectors.map((v) => v.slug);
      expect(new Set(slugs).size, `${profile.os} slugs`).toBe(slugs.length);
    }
  });

  it("produces distinct installer filenames per device, so nothing clobbers", () => {
    // Two vectors writing the same destination would mean the second silently
    // replaces the first and one alarm never fires.
    for (const profile of DEVICE_PROFILES) {
      const names = vectorsFor(profile.os).map((bv) => bv.installer.filename);
      expect(new Set(names).size, `${profile.os} filenames: ${names}`).toBe(
        names.length,
      );
    }
  });

  it("marks needsRoot wherever the installer's own steps demand elevation", () => {
    // Caught a real error: the Windows vectors were initially unflagged even
    // though every one of them registers a scheduled task from an elevated
    // shell. The flag drives the UI badge, the README and the sudo preflight,
    // so a wrong value misleads on all three.
    for (const profile of DEVICE_PROFILES) {
      for (const bv of vectorsFor(profile.os)) {
        const steps = [...bv.installer.install, ...bv.installer.uninstall]
          .join("\n")
          .toLowerCase();
        const demandsRoot = steps.includes("sudo ") || steps.includes("elevated");
        expect(
          Boolean(bv.vector.needsRoot),
          `${profile.os}/${bv.vector.slug}: installer ${demandsRoot ? "demands" : "does not demand"} elevation`,
        ).toBe(demandsRoot);
      }
    }
  });

  it("excludes vectors needing extra software from the defaults", () => {
    for (const profile of DEVICE_PROFILES) {
      const defaults = defaultVectorSlugs(profile.os);
      for (const v of profile.vectors) {
        if (v.needsExtraSetup) expect(defaults).not.toContain(v.slug);
        else expect(defaults).toContain(v.slug);
      }
    }
  });

  it("normalizes device names into one identity per machine", () => {
    const cases: Array<[string, string]> = [
      ["web01", "web01"],
      ["WEB01", "web01"],
      ["Web 01", "web-01"],
      ["  web-01  ", "web-01"],
      ["web/01", "web-01"],
      ["web___01", "web-01"],
      ["--web01--", "web01"],
      ["", ""],
    ];
    for (const [input, expected] of cases) {
      expect(normalizeDeviceName(input), input).toBe(expected);
    }
  });

  it("builds externalIds that are stable and unique per vector", () => {
    const profile = getDeviceProfile("macos");
    const ids = profile.vectors.map((v) => deviceExternalId("Web 01", "macos", v));
    expect(new Set(ids).size).toBe(ids.length);
    // Same machine, different spelling → same identity, so re-provisioning is
    // idempotent rather than minting a second set of keys.
    expect(deviceExternalId("WEB01", "macos", profile.vectors[0]!)).toBe(
      deviceExternalId("web01", "macos", profile.vectors[0]!),
    );
  });
});

describe("device bundle", () => {
  it("names the root after the device and OS", () => {
    expect(bundleRootName("Web 01", "linux")).toBe("web-01-linux");
    expect(bundleRootName("", "macos")).toBe("device-macos");
  });

  it.each(["macos", "linux"] as const)(
    "%s: ships one installer per vector plus scripts",
    async (os) => {
      const vectors = vectorsFor(os);
      const files = await unzip(
        await buildDeviceBundle({ deviceName: "web01", os, vectors }),
      );
      const root = bundleRootName("web01", os);

      expect(Object.keys(files)).toContain(`${root}/install.sh`);
      expect(Object.keys(files)).toContain(`${root}/uninstall.sh`);
      expect(Object.keys(files)).toContain(`${root}/README.txt`);
      for (const bv of vectors) {
        expect(
          files[`${root}/vectors/${bv.vector.slug}/${bv.installer.filename}`],
        ).toBe(bv.installer.content);
      }
    },
  );

  it("windows ships PowerShell scripts, not shell", async () => {
    const vectors = vectorsFor("windows");
    const files = await unzip(
      await buildDeviceBundle({ deviceName: "pc01", os: "windows", vectors }),
    );
    const root = bundleRootName("pc01", "windows");
    expect(Object.keys(files)).toContain(`${root}/install.ps1`);
    expect(Object.keys(files)).not.toContain(`${root}/install.sh`);
  });

  it.each(["macos", "linux"] as const)(
    "%s: every vector gets a real recipe, never the fallback",
    async (os) => {
      // The default branch of posixVectorBody emits this when a vector has no
      // automated recipe. It firing means an operator would believe an alarm
      // is armed when the bootstrap silently skipped it.
      const files = await unzip(
        await buildDeviceBundle({
          deviceName: "web01",
          os,
          vectors: vectorsFor(os),
        }),
      );
      const root = bundleRootName("web01", os);
      for (const phase of ["install", "uninstall"]) {
        expect(files[`${root}/${phase}.sh`]).not.toContain(
          "no automated recipe",
        );
      }
    },
  );

  it("windows resolves a task name for every vector", async () => {
    for (const bv of vectorsFor("windows")) {
      expect(
        windowsTaskName(bv.installer),
        `${bv.installer.type} has no /tn "..." step to parse`,
      ).toBeTruthy();
    }
  });

  it("uninstall removes the shell rc block it added, by marker", async () => {
    // The bug this guards: replaying Installer.uninstall would delete
    // ~/.mantis.sh but leave the `source` line, so every new shell errors.
    const vectors = vectorsFor("linux", ["login"]);
    const files = await unzip(
      await buildDeviceBundle({ deviceName: "web01", os: "linux", vectors }),
    );
    const root = bundleRootName("web01", "linux");
    const install = files[`${root}/install.sh`]!;
    const uninstall = files[`${root}/uninstall.sh`]!;

    expect(install).toContain("# >>> mantis:shell >>>");
    expect(install).toContain("# <<< mantis:shell <<<");
    // Guarded append: re-running must not duplicate the block.
    expect(install).toContain("grep -qF");
    // And the uninstaller must actually strip it.
    expect(uninstall).toMatch(/sed -i.*mantis:shell/);
    expect(uninstall).toContain('rm -f "$HOME/.mantis.sh"');
  });

  it("re-running install is safe for launchd and scheduled tasks", async () => {
    const mac = await unzip(
      await buildDeviceBundle({
        deviceName: "mac01",
        os: "macos",
        vectors: vectorsFor("macos", ["desktop-login"]),
      }),
    );
    expect(mac[`${bundleRootName("mac01", "macos")}/install.sh`]).toContain(
      "launchctl unload",
    );

    const win = await unzip(
      await buildDeviceBundle({
        deviceName: "pc01",
        os: "windows",
        vectors: vectorsFor("windows", ["logon"]),
      }),
    );
    expect(win[`${bundleRootName("pc01", "windows")}/install.ps1`]).toContain(
      "schtasks /delete",
    );
  });

  it("asks before changing the machine, and can be driven non-interactively", async () => {
    const files = await unzip(
      await buildDeviceBundle({
        deviceName: "web01",
        os: "linux",
        vectors: vectorsFor("linux"),
      }),
    );
    const sh = files[`${bundleRootName("web01", "linux")}/install.sh`]!;
    expect(sh).toContain("Continue? [y/N]");
    expect(sh).toContain("MANTIS_ASSUME_YES");
  });

  it("requires sudo up front when a vector needs root", async () => {
    const files = await unzip(
      await buildDeviceBundle({
        deviceName: "web01",
        os: "linux",
        vectors: vectorsFor("linux", ["boot"]),
      }),
    );
    expect(files[`${bundleRootName("web01", "linux")}/install.sh`]).toContain(
      "needs root",
    );
  });

  it("warns instead of silently arming a vector whose dependency is missing", async () => {
    const vectors = vectorsFor("macos", ["wake"]);
    const files = await unzip(
      await buildDeviceBundle({ deviceName: "mac01", os: "macos", vectors }),
    );
    const sh = files[`${bundleRootName("mac01", "macos")}/install.sh`]!;
    expect(sh).toContain("brew list --formula sleepwatcher");
    expect(sh).toContain("will not fire until it is");
  });

  it("preserves an existing ~/.wakeup rather than destroying it", async () => {
    const files = await unzip(
      await buildDeviceBundle({
        deviceName: "mac01",
        os: "macos",
        vectors: vectorsFor("macos", ["wake"]),
      }),
    );
    const root = bundleRootName("mac01", "macos");
    expect(files[`${root}/install.sh`]).toContain(".wakeup.pre-mantis");
    expect(files[`${root}/uninstall.sh`]).toContain("restored your original");
  });

  it("keeps the human-readable steps in the README as a manual fallback", async () => {
    const vectors = vectorsFor("macos");
    const files = await unzip(
      await buildDeviceBundle({ deviceName: "mac01", os: "macos", vectors }),
    );
    const readme = files[`${bundleRootName("mac01", "macos")}/README.txt`]!;
    for (const bv of vectors) {
      for (const step of bv.installer.install) {
        expect(readme).toContain(step);
      }
    }
  });

  it("neutralises quoting metacharacters in operator-supplied names", async () => {
    // The device name reaches a double-quoted shell string. Anything that could
    // close that string or start a substitution has to be gone by then, or a
    // memo becomes command execution on the operator's own machine.
    const evil = 'web01"; rm -rf $HOME; echo "$(id)`id`';
    const files = await unzip(
      await buildDeviceBundle({
        deviceName: evil,
        os: "linux",
        vectors: vectorsFor("linux", ["login"]),
      }),
    );
    const sh = files[`${bundleRootName(evil, "linux")}/install.sh`]!;
    const sayLine = sh.split("\n").find((l) => l.startsWith('say "Install'))!;

    // Everything after `say "` up to the final quote is interpolated content;
    // it must carry none of the four characters that break out of it.
    const body = sayLine.slice('say "'.length, -1);
    for (const ch of ['"', "$", "`", "\\"]) {
      expect(body, `${ch} survived into ${sayLine}`).not.toContain(ch);
    }
  });

  it("keeps a hostile device name out of the zip paths", async () => {
    const files = await unzip(
      await buildDeviceBundle({
        deviceName: "../../etc/cron.d/evil",
        os: "linux",
        vectors: vectorsFor("linux", ["login"]),
      }),
    );
    for (const path of Object.keys(files)) {
      expect(path, "traversal escaped the bundle root").not.toContain("..");
    }
  });
});
