import type { InstallType } from "./installers.js";

/**
 * Mirrors the `response_kind` Postgres enum (src/db/schema.ts in the server)
 * so this package stays database-free. Safe to mirror by hand: the server
 * assigns these values into columns typed by the real enum, so a value added
 * here that the database doesn't know fails the server typecheck. Device
 * profiles only ever use "empty" today.
 */
export type ResponseKind = "gif" | "empty" | "json" | "redirect" | "html";

/**
 * Device profiles: "I am setting up a new machine" → the full set of host
 * alarms that machine should carry, one key per vector.
 *
 * This is the transpose of the server's `src/lib/presets`. A preset answers "what am I
 * planting?" and bulk mode mints N keys of ONE preset (one document per
 * location). A device profile answers "what should watch this host?" and mints
 * ONE key per vector for a single machine. Both end in a zip; the preset zip
 * holds planted files, the device zip holds installers plus a bootstrap script.
 *
 * Why a key per vector rather than one key per machine: the hit tells you which
 * alarm fired. `web01 — wake from sleep` at 03:00 is a very different signal
 * from `web01 — sudo`, and a shared key collapses them into "something happened
 * on web01".
 *
 * Response kind is `empty` throughout — every vector here is fetched by a
 * script (curl in a launchd/systemd/Task Scheduler job), never rendered, so a
 * 204 is the smallest and quietest reply. See the same reasoning in presets.ts.
 */

export type DeviceOs = "macos" | "linux" | "windows";

export type DeviceVector = {
  /** The installer this vector deploys — see `./installers`. */
  installType: InstallType;
  /** Stable slug: used in the memo, the bundle directory, and the externalId. */
  slug: string;
  /** Short label for the memo suffix. Deliberately shorter than INSTALLER_META. */
  label: string;
  /** One line: what actually trips it. */
  blurb: string;
  responseKind: ResponseKind;
  /**
   * Host events should page every time, so dedupe is off — except network
   * attach, which genuinely bursts (a Wi-Fi roam rewrites resolv.conf several
   * times) and would otherwise be noise.
   */
  dedupeWindowSeconds: number;
  /** Needs root to install. Surfaced up front so the bundle can warn. */
  needsRoot?: boolean;
  /**
   * A dependency the host almost certainly doesn't have yet (macOS has no
   * built-in user-space wake hook, so the wake vector needs sleepwatcher).
   *
   * Structured rather than prose because both surfaces act on it: the dashboard
   * shows `why` + `install` as a warning the moment the vector is ticked, and
   * the CLI runs `detect` and offers to run `install` for you. Vectors carrying
   * this are off by default (see `defaultVectorSlugs`) — an alarm that looks
   * armed but silently never fires is worse than one you knowingly skipped.
   */
  needsExtraSetup?: ExtraSetup;
};

export type ExtraSetup = {
  /** What's missing, named the way the operator would recognise it. */
  what: string;
  /** Why the vector can't work without it. */
  why: string;
  /** Shell test that exits 0 when the dependency is already present. */
  detect: string;
  /** Commands that install and enable it, in order. */
  install: string[];
  /**
   * Test for the thing that provides `install` (Homebrew, apt, …). When this
   * fails we can't offer to install anything and must say so instead of
   * running a command that will fail confusingly.
   */
  requires: { detect: string; label: string };
};

/**
 * macOS ships no user-space wake hook, so `macos-wake` is a sleepwatcher
 * (~/.wakeup) script. Detection goes through `brew list` rather than
 * `command -v`: Homebrew installs sleepwatcher into $(brew --prefix)/sbin,
 * which is not on the default PATH, so `command -v sleepwatcher` reports
 * missing on a machine that has it.
 */
const SLEEPWATCHER: ExtraSetup = {
  what: "sleepwatcher",
  why: "macOS has no built-in user-space wake hook. sleepwatcher provides one by running ~/.wakeup on resume, which is where this vector installs its script.",
  detect: "brew list --formula sleepwatcher",
  install: ["brew install sleepwatcher", "brew services start sleepwatcher"],
  requires: { detect: "command -v brew", label: "Homebrew" },
};

export type DeviceProfile = {
  os: DeviceOs;
  label: string;
  /** Shown under the OS tile. */
  blurb: string;
  vectors: DeviceVector[];
};

const SHELL_LOGIN: DeviceVector = {
  installType: "shell",
  slug: "login",
  label: "shell / SSH login",
  blurb: "Fires on every interactive shell — this is the SSH login alarm.",
  responseKind: "empty",
  dedupeWindowSeconds: 0,
};

const SHELL_SUDO: DeviceVector = {
  installType: "shell-sudo",
  slug: "sudo",
  label: "sudo",
  blurb: "Fires whenever sudo runs, and reports the command and user.",
  responseKind: "empty",
  dedupeWindowSeconds: 0,
};

export const DEVICE_PROFILES: DeviceProfile[] = [
  {
    os: "macos",
    label: "macOS",
    blurb: "LaunchAgents, LaunchDaemons and shell hooks.",
    vectors: [
      SHELL_LOGIN,
      SHELL_SUDO,
      {
        installType: "macos-login",
        slug: "desktop-login",
        label: "desktop login",
        blurb: "Fires once when someone logs in at the desktop. Per-user, no root.",
        responseKind: "empty",
        dedupeWindowSeconds: 0,
      },
      {
        installType: "macos-wake",
        slug: "wake",
        label: "wake from sleep",
        blurb: "Fires when the Mac wakes. A laptop waking at 03:00 is worth knowing about.",
        responseKind: "empty",
        dedupeWindowSeconds: 0,
        needsExtraSetup: SLEEPWATCHER,
      },
      {
        installType: "macos-boot",
        slug: "boot",
        label: "system boot",
        blurb: "Fires at boot, before any user logs in.",
        responseKind: "empty",
        dedupeWindowSeconds: 0,
        needsRoot: true,
      },
      {
        installType: "macos-network",
        slug: "network",
        label: "network attach",
        blurb: "Fires on every Wi-Fi join, ethernet plug or VPN connect.",
        responseKind: "empty",
        dedupeWindowSeconds: 60,
      },
    ],
  },
  {
    os: "linux",
    label: "Linux",
    blurb: "systemd units, NetworkManager dispatcher and shell hooks.",
    vectors: [
      SHELL_LOGIN,
      SHELL_SUDO,
      {
        installType: "linux-boot",
        slug: "boot",
        label: "system boot",
        blurb: "systemd unit that fires once the network is up.",
        responseKind: "empty",
        dedupeWindowSeconds: 0,
        needsRoot: true,
      },
      {
        installType: "linux-wake",
        slug: "wake",
        label: "wake from sleep",
        blurb: "systemd unit on the suspend/hibernate targets. Fires on resume.",
        responseKind: "empty",
        dedupeWindowSeconds: 0,
        needsRoot: true,
      },
      {
        installType: "linux-network",
        slug: "network",
        label: "network attach",
        blurb: "NetworkManager dispatcher script. Fires when an interface comes up.",
        responseKind: "empty",
        dedupeWindowSeconds: 60,
        needsRoot: true,
      },
    ],
  },
  {
    os: "windows",
    label: "Windows",
    blurb: "Task Scheduler jobs, imported with schtasks.",
    vectors: [
      // All three register scheduled tasks via `schtasks /create`, which needs
      // an elevated shell for logon and event-log triggers — the installers say
      // so in their own steps, and install.ps1 refuses to run without it.
      {
        installType: "windows-logon",
        slug: "logon",
        label: "user logon",
        blurb: "Fires on any user logon, including RDP sessions.",
        responseKind: "empty",
        dedupeWindowSeconds: 0,
        needsRoot: true,
      },
      {
        installType: "windows-wake",
        slug: "wake",
        label: "wake from sleep",
        blurb: "Power-Troubleshooter event 1. Fires on resume from sleep or hibernate.",
        responseKind: "empty",
        dedupeWindowSeconds: 0,
        needsRoot: true,
      },
      {
        installType: "windows-network",
        slug: "network",
        label: "network attach",
        blurb: "NetworkProfile event 10000. Fires when a network connects.",
        responseKind: "empty",
        dedupeWindowSeconds: 60,
        needsRoot: true,
      },
    ],
  },
];

export const ALL_DEVICE_OS: DeviceOs[] = DEVICE_PROFILES.map((p) => p.os);

export function isDeviceOs(v: string): v is DeviceOs {
  return (ALL_DEVICE_OS as string[]).includes(v);
}

export function getDeviceProfile(os: DeviceOs): DeviceProfile {
  const found = DEVICE_PROFILES.find((p) => p.os === os);
  // isDeviceOs is the only way to obtain a DeviceOs, so this is unreachable.
  if (!found) throw new Error(`unknown device OS: ${os}`);
  return found;
}

/**
 * Vectors selected by default: everything that installs without fetching extra
 * software. Root is still fine to default on — the bootstrap script asks for it
 * once — but a vector that silently does nothing until you `brew install`
 * something would be a canary that looks armed and isn't.
 */
export function defaultVectorSlugs(os: DeviceOs): string[] {
  return getDeviceProfile(os)
    .vectors.filter((v) => !v.needsExtraSetup)
    .map((v) => v.slug);
}

export function getVector(os: DeviceOs, slug: string): DeviceVector | undefined {
  return getDeviceProfile(os).vectors.find((v) => v.slug === slug);
}

/**
 * Memo for a device key. Keep the device name first so the keys list sorts and
 * greps by machine, which is how you actually look them up.
 */
export function deviceMemo(deviceName: string, vector: DeviceVector): string {
  return `${deviceName} — ${vector.label}`;
}

/**
 * Stable identity for idempotent minting: re-running the same device+vector
 * returns the existing key instead of minting a duplicate (see keys.externalId
 * and the POST /api/keys idempotency path). Re-provisioning a rebuilt machine
 * therefore reuses its keys rather than littering the list with a second set.
 */
export function deviceExternalId(
  deviceName: string,
  os: DeviceOs,
  vector: DeviceVector,
): string {
  return `mantis:device:${os}:${normalizeDeviceName(deviceName)}:${vector.slug}`;
}

/**
 * Validation shared by the dashboard action and the CLI, so both reject the
 * same names for the same reasons.
 *
 * The empty-after-normalize case is the one that matters: a name of only
 * punctuation normalizes to "", every vector's externalId collapses to
 * `mantis:device:macos::wake`, and the next such device silently claims the
 * first one's keys through the idempotency path.
 */
export function deviceNameError(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return "enter a device name";
  if (trimmed.length > 200) return "device name too long (max 200)";
  if (!normalizeDeviceName(trimmed)) {
    return "device name needs at least one letter or digit";
  }
  return null;
}

/**
 * Device names reach us from a form field and a CLI flag, and end up in an
 * externalId (a uniqueness key) and a zip path. Fold case and collapse
 * separators so "Web 01", "web-01" and "WEB01" are the same machine, and strip
 * anything that would be awkward in a path.
 */
export function normalizeDeviceName(name: string): string {
  return name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}
