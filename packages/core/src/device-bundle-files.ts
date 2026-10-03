import type { DeviceOs, DeviceVector } from "./device-profiles.js";
import { normalizeDeviceName } from "./device-profiles.js";
import type { Installer } from "./installers.js";

/**
 * Builds the file map a device mint hands back: every vector's installer file,
 * plus a bootstrap that installs all of them and an uninstaller that removes
 * them. The zip wrapper lives in `./device-bundle` — this module is split off
 * so the CLI (which ships the bundle as a plain directory) never pulls jszip
 * into its standalone binaries.
 *
 * WHY THIS DOESN'T JUST REPLAY `Installer.install`
 * ------------------------------------------------
 * Those arrays are written for a human reading the key page, and three
 * properties make them unsafe to concatenate into a script:
 *
 *   1. Some entries are prose, not commands. `shell` uninstalls with
 *      "# Remove the 'source ~/.mantis.sh' line from ~/.zshrc" — replay it and
 *      the uninstaller deletes the file but leaves the `source` line behind, so
 *      every new shell errors on a file that is gone.
 *   2. They aren't idempotent. `echo 'source …' >> ~/.zshrc` appends a
 *      duplicate line on every run.
 *   3. They assume zsh. A bash user gets a line in an rc file they never read,
 *      and a canary that silently never fires.
 *
 * So the bootstrap implements the same *operations* properly — guarded rc
 * blocks, detected shell, unload-before-load — and `install[]` stays what it
 * always was: the human-readable reference, reproduced in README.txt.
 *
 * Everything here is generated text; nothing executes at build time. The
 * operator reads the script before running it, which is the point of shipping a
 * bundle rather than a `curl | sh`.
 */

export type BundleVector = {
  vector: DeviceVector;
  installer: Installer;
  key: { id: string; publicId: string; memo: string };
};

export type DeviceBundleInput = {
  /** As typed by the operator — used for display and paths, not identity. */
  deviceName: string;
  os: DeviceOs;
  vectors: BundleVector[];
  /** Absolute base URL of this mantis instance, for the README. */
  baseUrl?: string;
};

/** Marker pair wrapping our block in a shell rc file, so removal is exact. */
function rcMarkers(slug: string): { open: string; close: string } {
  return {
    open: `# >>> mantis:${slug} >>>`,
    close: `# <<< mantis:${slug} <<<`,
  };
}

export function bundleRootName(deviceName: string, os: DeviceOs): string {
  return `${normalizeDeviceName(deviceName) || "device"}-${os}`;
}

export type BundleFiles = {
  /** Directory name the files sit under in the zip. */
  root: string;
  /** Script to run, relative to `root`. */
  installScript: string;
  uninstallScript: string;
  /** Relative path → contents. Paths are always POSIX-separated. */
  files: Record<string, string>;
};

/**
 * The bundle as a plain file map, before it becomes a zip.
 *
 * `mantis device --install` materializes this into a temp directory and runs
 * the same script the zip ships, so the local-install path and the download
 * path exercise one implementation rather than two that can drift.
 */
export function buildDeviceBundleFiles(rawInput: DeviceBundleInput): BundleFiles {
  // The device name lands in `#` comment lines of the generated scripts; a
  // newline would end the comment, so collapse control characters first (the
  // same set as templateSafeText: ASCII and C1 controls, LS and PS).
  const input: DeviceBundleInput = {
    ...rawInput,
    deviceName: rawInput.deviceName
      .replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]+/g, " ")
      .trim(),
  };
  const root = bundleRootName(input.deviceName, input.os);
  const windows = input.os === "windows";
  const installScript = windows ? "install.ps1" : "install.sh";
  const uninstallScript = windows ? "uninstall.ps1" : "uninstall.sh";

  const files: Record<string, string> = {
    "README.txt": buildReadme(input),
    [installScript]: windows
      ? buildWindowsScript(input, "install")
      : buildPosixScript(input, "install"),
    [uninstallScript]: windows
      ? buildWindowsScript(input, "uninstall")
      : buildPosixScript(input, "uninstall"),
  };

  for (const bv of input.vectors) {
    files[`vectors/${bv.vector.slug}/${bv.installer.filename}`] =
      bv.installer.content;
  }

  return { root, installScript, uninstallScript, files };
}

/* -------------------------------------------------------------------------- */
/* POSIX                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Per-vector install/uninstall bodies for macOS and Linux.
 *
 * Destinations are derived from the installer's own `filename` so a rename
 * upstream flows through here; only the *destination directory* and the
 * activation command are stated locally. `deviceBundleDrift` (see the tests)
 * asserts each of these still matches the installer's documented steps.
 *
 * Per-user vectors never touch `$HOME` or run a bare command against the
 * home directory: they go through `$USER_HOME` and the `as_user` /
 * `user_install` / `user_append` / `user_launchctl` helpers that
 * `posixUserPreamble` defines, so a root run installs them for the intended
 * account, as that account.
 */
function posixVectorBody(
  bv: BundleVector,
  phase: "install" | "uninstall",
): string[] {
  const f = bv.installer.filename;
  const type = bv.installer.type;
  const src = `"$BUNDLE/vectors/${bv.vector.slug}/${f}"`;

  switch (type) {
    case "shell":
    case "shell-sudo": {
      // Fixed dotfile paths, matching the documented single-key install.
      const file = type === "shell" ? ".mantis.sh" : ".mantis-sudo.sh";
      const dest = `$USER_HOME/${file}`;
      // The line written into the rc file is read later by the account's own
      // shell, so it names the file through that shell's $HOME.
      const sourced = `$HOME/${file}`;
      const { open, close } = rcMarkers(`${type}`);
      if (phase === "install") {
        return [
          `user_install 600 ${src} "${dest}"`,
          `for rc in $(mantis_rc_files); do`,
          `  if ! as_user grep -qF '${open}' "$rc" 2>/dev/null; then`,
          `    printf '%s\\n' '' '${open}' '[ -f "${sourced}" ] && . "${sourced}"' '${close}' | user_append "$rc"`,
          `    say "  + sourced from $rc"`,
          `  else`,
          `    say "  = already sourced from $rc"`,
          `  fi`,
          `done`,
        ];
      }
      return [
        `for rc in $(mantis_rc_files); do`,
        `  as_user test -f "$rc" || continue`,
        // Delete the marked block inclusively. Exact markers mean we never
        // touch a line the operator wrote themselves.
        `  as_user sed -i.mantis-bak '/${escapeSed(open)}/,/${escapeSed(close)}/d' "$rc" && as_user rm -f "$rc.mantis-bak"`,
        `done`,
        `as_user rm -f "${dest}"`,
      ];
    }

    case "macos-login":
    case "macos-network": {
      const dest = `$USER_HOME/Library/LaunchAgents/${f}`;
      if (phase === "install") {
        return [
          `as_user mkdir -p "$USER_HOME/Library/LaunchAgents"`,
          // Unload first so re-running the bundle reloads cleanly instead of
          // failing with "service already loaded".
          `user_launchctl unload "${dest}" 2>/dev/null || true`,
          `user_install 644 ${src} "${dest}"`,
          `user_launchctl load "${dest}"`,
        ];
      }
      return [
        `user_launchctl unload "${dest}" 2>/dev/null || true`,
        `as_user rm -f "${dest}"`,
      ];
    }

    case "macos-boot": {
      const dest = `/Library/LaunchDaemons/${f}`;
      if (phase === "install") {
        return [
          `$SUDO launchctl unload "${dest}" 2>/dev/null || true`,
          `$SUDO install -m 644 -o root -g wheel ${src} "${dest}"`,
          `$SUDO launchctl load "${dest}"`,
        ];
      }
      return [
        `$SUDO launchctl unload "${dest}" 2>/dev/null || true`,
        `$SUDO rm -f "${dest}"`,
      ];
    }

    case "macos-wake": {
      // sleepwatcher hardcodes ~/.wakeup, so there is exactly one slot on the
      // machine. Preserve anything already there rather than silently
      // destroying an operator's own wake script.
      if (phase === "install") {
        return [
          `if as_user test -e "$USER_HOME/.wakeup" && ! as_user grep -q 'X-Mantis-Source: macos-wake' "$USER_HOME/.wakeup" 2>/dev/null; then`,
          `  say "  ! existing ~/.wakeup preserved as ~/.wakeup.pre-mantis"`,
          `  as_user mv "$USER_HOME/.wakeup" "$USER_HOME/.wakeup.pre-mantis"`,
          `fi`,
          `user_install 755 ${src} "$USER_HOME/.wakeup"`,
        ];
      }
      return [
        `as_user rm -f "$USER_HOME/.wakeup"`,
        `if as_user test -e "$USER_HOME/.wakeup.pre-mantis"; then`,
        `  as_user mv "$USER_HOME/.wakeup.pre-mantis" "$USER_HOME/.wakeup"`,
        `  say "  + restored your original ~/.wakeup"`,
        `fi`,
      ];
    }

    case "linux-boot":
    case "linux-wake": {
      const dest = `/etc/systemd/system/${f}`;
      if (phase === "install") {
        return [
          `$SUDO install -m 644 -o root -g root ${src} "${dest}"`,
          `$SUDO systemctl daemon-reload`,
          `$SUDO systemctl enable ${f}`,
        ];
      }
      return [
        `$SUDO systemctl disable ${f} 2>/dev/null || true`,
        `$SUDO rm -f "${dest}"`,
        `$SUDO systemctl daemon-reload`,
      ];
    }

    case "linux-network": {
      const dest = `/etc/NetworkManager/dispatcher.d/${f}`;
      if (phase === "install") {
        return [
          `$SUDO install -m 755 -o root -g root ${src} "${dest}"`,
        ];
      }
      return [`$SUDO rm -f "${dest}"`];
    }

    default:
      // A vector reached the bundle with no POSIX recipe. Fail loudly in the
      // generated script rather than silently skipping an alarm the operator
      // believes is armed.
      return [
        `say "  ! no automated recipe for ${type}; see README.txt and install by hand"`,
        `FAILED=$((FAILED+1))`,
      ];
  }
}

/** Install types that live in one login account's home, not system-wide. */
const PER_USER_TYPES: ReadonlySet<Installer["type"]> = new Set([
  "shell",
  "shell-sudo",
  "macos-login",
  "macos-network",
  "macos-wake",
]);

function isPerUser(bv: BundleVector): boolean {
  return PER_USER_TYPES.has(bv.installer.type);
}

/** Single-quote a string for POSIX sh. */
function shSingle(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Decides which account the per-user vectors belong to, and how to act as it.
 *
 * Run as that account (the documented path), nothing changes: `$HOME`,
 * `$SHELL`, plain commands. Run as root, `$HOME` and `$SHELL` are root's, and
 * installing "here" without asking whose alarms these are can arm the wrong
 * account and still print "done.". So as root the target is resolved
 * explicitly, its home and login shell come from the user database rather
 * than the environment, and the operator is told who it is before the prompt:
 *
 *   1. MANTIS_TARGET_USER, when set — an explicit choice, root included.
 *   2. The sudo caller, when there is one and it is not root.
 *   3. Linux: root itself. A direct root login is how a root-only server or
 *      container is administered, so root IS the account to watch there.
 *      macOS: the console user. Root is not a login account on a Mac and MDM
 *      agents run as root, so with nobody at the console there is no account
 *      to act for.
 *
 * Acting for another account means running every per-user step *as* that
 * account. Dropping privileges is deliberate: root appending to an rc file
 * inside a directory the user controls would follow whatever symlink the user
 * left there. When no usable account exists (unknown user, no home directory,
 * no way to drop privileges, or on macOS nobody to act for) the vectors are
 * skipped and counted as failed, so the script exits non-zero instead of
 * reporting an alarm that isn't armed.
 */
function posixUserPreamble(os: DeviceOs, phase: "install" | "uninstall"): string[] {
  const doing = phase === "install" ? "installed" : "removed";
  const mac = os === "macos";

  // Who the alarms are for, as root. Leaves TARGET_USER set, or (macOS only)
  // USER_SKIP when there is nobody to act for.
  const resolve = mac
    ? [
        "# MANTIS_TARGET_USER is an explicit choice (and may name root). Otherwise",
        "# it is whoever ran sudo, else whoever is logged in at the console - but",
        "# never uid 0, and never the placeholder accounts that own the console at",
        "# the login window: root is not a login account on a Mac.",
        'TARGET_USER="${MANTIS_TARGET_USER:-}"',
        'if [ -z "$TARGET_USER" ]; then',
        '  TARGET_USER="${SUDO_USER:-}"',
        '  if [ -z "$TARGET_USER" ] || [ "$TARGET_USER" = root ]; then',
        '    TARGET_USER="$(stat -f %Su /dev/console 2>/dev/null || true)"',
        "  fi",
        '  case "$TARGET_USER" in loginwindow|_mbsetupuser) TARGET_USER="" ;; esac',
        '  if [ -n "$TARGET_USER" ] && [ "$(id -u "$TARGET_USER" 2>/dev/null || echo 0)" -eq 0 ]; then',
        '    TARGET_USER=""',
        "  fi",
        "fi",
      ]
    : [
        'USER_HINT=""',
        "# MANTIS_TARGET_USER is an explicit choice. Otherwise it is whoever ran",
        "# sudo. With no sudo caller (or one that is root too) this is root's own",
        "# login, as on a root-only server or container, and root is the account",
        "# to watch.",
        'TARGET_USER="${MANTIS_TARGET_USER:-}"',
        'if [ -z "$TARGET_USER" ]; then',
        '  TARGET_USER="${SUDO_USER:-}"',
        '  if [ -z "$TARGET_USER" ] || [ "$(id -u "$TARGET_USER" 2>/dev/null || echo unknown)" = 0 ]; then',
        '    TARGET_USER="$(id -un 2>/dev/null || echo root)"',
        `    USER_HINT=" Set MANTIS_TARGET_USER=<name> to ${phase === "install" ? "watch another account" : "remove them from another account"} instead."`,
        "  fi",
        "fi",
      ];

  // How to act as TARGET_USER. Sets USER_SKIP when that is not possible.
  const become = [
    'TARGET_UID="$(id -u "$TARGET_USER" 2>/dev/null || true)"',
    "# Home and login shell from the user database, not from the environment.",
    ...(mac
      ? [
          `USER_HOME="$(dscl . -read "/Users/$TARGET_USER" NFSHomeDirectory 2>/dev/null | sed -n 's/^NFSHomeDirectory: *//p')"`,
          `USER_SHELL="$(dscl . -read "/Users/$TARGET_USER" UserShell 2>/dev/null | sed -n 's/^UserShell: *//p')"`,
        ]
      : [
          // getent is missing on some minimal images (BusyBox); the local
          // passwd file is the same database there.
          `TARGET_PASSWD="$(getent passwd "$TARGET_USER" 2>/dev/null || awk -F: -v u="$TARGET_USER" '$1 == u { print; exit }' /etc/passwd 2>/dev/null || true)"`,
          `USER_HOME="$(printf '%s\\n' "$TARGET_PASSWD" | cut -d: -f6)"`,
          `USER_SHELL="$(printf '%s\\n' "$TARGET_PASSWD" | cut -d: -f7)"`,
        ]),
    'if [ -z "$TARGET_UID" ] || [ -z "$USER_HOME" ] || [ ! -d "$USER_HOME" ]; then',
    `  USER_SKIP="could not find a home directory for '$TARGET_USER'."`,
    'elif [ "$TARGET_UID" -eq 0 ]; then',
    "  : # Acting for root itself: there is nothing to drop to.",
    ...(mac
      ? []
      : [
          "elif command -v runuser >/dev/null 2>&1; then",
          '  as_user() { (cd / && runuser -u "$TARGET_USER" -- env HOME="$USER_HOME" "$@"); }',
        ]),
    "elif command -v sudo >/dev/null 2>&1; then",
    '  as_user() { (cd / && sudo -u "$TARGET_USER" env HOME="$USER_HOME" "$@"); }',
    "else",
    mac
      ? `  USER_SKIP="cannot act as '$TARGET_USER': sudo is not available."`
      : `  USER_SKIP="cannot act as '$TARGET_USER': neither runuser nor sudo is available."`,
    "fi",
    'if [ -z "$USER_SKIP" ] && [ "$TARGET_UID" -ne 0 ]; then',
    "  # Root only reads the bundle (which the target may not be able to); the",
    "  # write into the home directory happens as the target, and replaces",
    "  # whatever is at the destination instead of writing through it.",
    `  user_install() { as_user sh -c 'rm -f "$2" && umask 077 && cat > "$2" && chmod "$1" "$2"' mantis "$1" "$3" < "$2"; }`,
    `  user_append() { as_user sh -c 'cat >> "$1"' mantis "$1"; }`,
    ...(mac
      ? [
          "  # launchctl asuser runs the command inside the target's own launchd",
          "  # session, which is where a LaunchAgent has to be loaded.",
          '  user_launchctl() { (cd / && launchctl asuser "$TARGET_UID" sudo -u "$TARGET_USER" launchctl "$@"); }',
        ]
      : []),
    "fi",
  ];

  const indent = (ls: string[], by: string) => ls.map((l) => by + l);
  return [
    "# Per-user alarms (shell hooks, LaunchAgents) belong to one login account:",
    "# they live in its home and follow its login shell. As root, work out who",
    "# the alarms are for and act as that account.",
    'USER_SKIP=""',
    'USER_NOTE=""',
    'as_user() { "$@"; }',
    'user_install() { install -m "$1" "$2" "$3"; }',
    'user_append() { cat >> "$1"; }',
    ...(mac ? ['user_launchctl() { launchctl "$@"; }'] : []),
    'if [ "$(id -u)" -ne 0 ]; then',
    '  USER_HOME="$HOME"',
    '  USER_SHELL="${SHELL:-/bin/sh}"',
    "else",
    '  USER_HOME=""',
    '  USER_SHELL=""',
    ...indent(resolve, "  "),
    // Linux always has a target by now (root itself if nobody else); on macOS
    // there may be none, and then there is nothing to become.
    ...(mac
      ? [
          '  if [ -z "$TARGET_USER" ]; then',
          `    USER_SKIP="no login account to act for. Run this script as that user, or set MANTIS_TARGET_USER=<name> (MANTIS_TARGET_USER=root if root's own shells are what you want watched)."`,
          "  else",
          ...indent(become, "    "),
          "  fi",
        ]
      : indent(become, "  ")),
    '  if [ -n "$USER_SKIP" ]; then',
    `    USER_NOTE="Running as root: per-user alarms will NOT be ${doing} - $USER_SKIP"`,
    "  else",
    `    USER_NOTE="Running as root: per-user alarms will be ${doing} for $TARGET_USER ($USER_HOME).${mac ? "" : "$USER_HINT"}"`,
    "  fi",
    "fi",
    "",
    "# Gate for each per-user vector: with no usable account, say so and count it",
    "# as failed rather than skip an alarm the operator believes is armed.",
    "mantis_user_ready() {",
    '  [ -n "$USER_SKIP" ] || return 0',
    '  say "  ! skipped: $USER_SKIP"',
    "  FAILED=$((FAILED+1))",
    "  return 1",
    "}",
    "",
  ];
}

function buildPosixScript(
  input: DeviceBundleInput,
  phase: "install" | "uninstall",
): string {
  const verb = phase === "install" ? "Install" : "Remove";
  const needsRoot = input.vectors.some((v) => v.vector.needsRoot);
  const hasPerUser = input.vectors.some(isPerUser);
  const lines: string[] = [];

  lines.push(
    "#!/bin/sh",
    "# Generated by mantis. Review before running — this changes login, boot and",
    "# network hooks on this machine.",
    "#",
    `# Device : ${input.deviceName}`,
    `# OS     : ${input.os}`,
    `# Vectors: ${input.vectors.length}`,
    "set -eu",
    "",
    'BUNDLE="$(cd "$(dirname "$0")" && pwd)"',
    "FAILED=0",
    "",
    'say() { printf "%s\\n" "$*"; }',
    "",
    "# Which rc files to wire the shell hooks into: the ones the login shell of",
    "# the account being watched reads, since that is what a new terminal runs.",
    "mantis_rc_files() {",
    '  case "$(basename "${USER_SHELL:-/bin/sh}")" in',
    '    zsh)  printf "%s\\n" "$USER_HOME/.zshrc" ;;',
    '    bash) printf "%s\\n" "$USER_HOME/.bashrc" ;;',
    '    *)    printf "%s\\n" "$USER_HOME/.profile" ;;',
    "  esac",
    "}",
    "",
  );

  if (hasPerUser) {
    for (const l of posixUserPreamble(input.os, phase)) lines.push(l);
  }

  if (needsRoot) {
    lines.push(
      "# Some vectors install system-wide (LaunchDaemons / systemd units).",
      'if [ "$(id -u)" -eq 0 ]; then',
      '  SUDO=""',
      "elif command -v sudo >/dev/null 2>&1; then",
      '  SUDO="sudo"',
      "else",
      '  say "error: this bundle needs root for some vectors, and sudo is not available."',
      "  exit 1",
      "fi",
      "",
    );
  } else {
    lines.push('SUDO=""', "");
  }

  // Confirmation. MANTIS_ASSUME_YES exists so the same script can be driven
  // from configuration management; interactive runs still get a prompt.
  lines.push(
    `say "${verb} ${input.vectors.length} mantis alarm(s) for '${shq(input.deviceName)}':"`,
  );
  for (const bv of input.vectors) {
    lines.push(`say "  - ${shq(bv.vector.label)} (${bv.vector.slug})"`);
  }
  if (hasPerUser) lines.push('[ -z "$USER_NOTE" ] || say "$USER_NOTE"');
  lines.push(
    "say \"\"",
    'if [ "${MANTIS_ASSUME_YES:-0}" != "1" ]; then',
    `  printf "Continue? [y/N] "`,
    "  read -r reply </dev/tty || reply=n",
    '  case "$reply" in y|Y|yes|YES) ;; *) say "aborted."; exit 1 ;; esac',
    "fi",
    "say \"\"",
    "",
  );

  for (const bv of input.vectors) {
    lines.push(
      `# --- ${bv.vector.label} (${bv.installer.type}) ---`,
      `say "${verb === "Install" ? "installing" : "removing"} ${shq(bv.vector.label)}…"`,
    );

    const body: string[] = [];
    const perUser = isPerUser(bv);
    const extra = bv.vector.needsExtraSetup;
    if (extra && phase === "install") {
      // A per-user dependency is the account's own (Homebrew refuses to run as
      // root at all), so probe for it as that account.
      const probe = (cmd: string) =>
        perUser ? `as_user sh -c ${shSingle(cmd)}` : cmd;
      body.push(
        `if ! ${probe(extra.detect)} >/dev/null 2>&1; then`,
        `  say "  ! ${shq(extra.what)} is not installed — this alarm will not fire until it is."`,
        // Distinguish "you need to install X" from "you can't install X here":
        // suggesting `brew install …` on a machine with no Homebrew sends the
        // operator to a command that fails for an unrelated reason.
        `  if ${probe(extra.requires.detect)} >/dev/null 2>&1; then`,
        `    say "    ${shq(extra.install.join(" && "))}"`,
        `  else`,
        `    say "    ${shq(extra.what)} needs ${shq(extra.requires.label)}, which is not installed either."`,
        `  fi`,
        `  say "    ${shq(extra.why)}"`,
        `  FAILED=$((FAILED+1))`,
        `else`,
      );
    }

    for (const l of posixVectorBody(bv, phase)) body.push(l);

    if (extra && phase === "install") body.push("fi");

    if (perUser) {
      lines.push("if mantis_user_ready; then");
      for (const l of body) lines.push(`  ${l}`);
      lines.push("fi");
    } else {
      for (const l of body) lines.push(l);
    }
    lines.push("");
  }

  lines.push(
    'if [ "$FAILED" -gt 0 ]; then',
    `  say "done, with $FAILED vector(s) needing attention — see the notes above."`,
    "  exit 2",
    "fi",
    `say "done."`,
    "",
  );

  return lines.join("\n");
}

/* -------------------------------------------------------------------------- */
/* Windows                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Scheduled-task name, read back out of the installer's own uninstall step
 * (`schtasks /delete /tn "Mantis Wake abc12345" /f`) rather than recomputed
 * here. Recomputing would duplicate the naming scheme and drift silently; the
 * uninstall line is a single, stable, machine-readable source of truth.
 */
export function windowsTaskName(installer: Installer): string | null {
  for (const step of [...installer.uninstall, ...installer.install]) {
    const m = step.match(/\/tn\s+"([^"]+)"/);
    if (m?.[1]) return m[1];
  }
  return null;
}

function buildWindowsScript(
  input: DeviceBundleInput,
  phase: "install" | "uninstall",
): string {
  const verb = phase === "install" ? "Install" : "Remove";
  const lines: string[] = [];

  lines.push(
    "# Generated by mantis. Review before running.",
    "#",
    `# Device : ${input.deviceName}`,
    `# Vectors: ${input.vectors.length}`,
    "#",
    "# Scheduled tasks with logon and event triggers require an elevated shell.",
    "# Right-click PowerShell -> Run as Administrator, then:",
    "#   Set-ExecutionPolicy -Scope Process Bypass",
    `#   .\\${phase}.ps1`,
    "",
    "$ErrorActionPreference = 'Stop'",
    "$bundle = Split-Path -Parent $MyInvocation.MyCommand.Path",
    "$failed = 0",
    "",
    "$id = [Security.Principal.WindowsIdentity]::GetCurrent()",
    "$principal = New-Object Security.Principal.WindowsPrincipal($id)",
    "if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {",
    "  Write-Error 'This script must run in an elevated PowerShell.'",
    "  exit 1",
    "}",
    "",
    `Write-Host "${verb} ${input.vectors.length} mantis alarm(s) for '${psq(input.deviceName)}':"`,
  );
  for (const bv of input.vectors) {
    lines.push(`Write-Host "  - ${psq(bv.vector.label)}"`);
  }
  lines.push(
    "if ($env:MANTIS_ASSUME_YES -ne '1') {",
    "  $reply = Read-Host 'Continue? [y/N]'",
    "  if ($reply -notmatch '^(y|Y|yes|YES)$') { Write-Host 'aborted.'; exit 1 }",
    "}",
    "",
  );

  if (phase === "install") {
    // Nothing else in this script can make a failed registration visible:
    // without these checks a rejected task still ends in "done." and exit 0,
    // and the CLI reports the device as armed.
    lines.push(
      "# schtasks is a native command: 'Stop' never looks at its exit code, and",
      "# Windows PowerShell 5.1 turns whatever it prints to a redirected stderr",
      "# into a terminating error. So run it under 'Continue', keep what it",
      "# printed, and hand back the exit code for the caller to judge.",
      "$schtasksOutput = ''",
      "function Invoke-Schtasks {",
      "  $ErrorActionPreference = 'Continue'",
      "  $global:LASTEXITCODE = 1",
      `  $script:schtasksOutput = (& schtasks.exe @args 2>&1 | ForEach-Object { "$_" }) -join ' '`,
      "  return $LASTEXITCODE",
      "}",
      "",
      "# Register one task from its XML. True only when schtasks reports success",
      "# AND the task can be queried afterwards.",
      "function Register-MantisTask([string]$Task, [string]$Xml) {",
      "  # Replace any earlier copy. This fails when the task does not exist yet",
      "  # (the normal first run), so its exit code is deliberately not counted.",
      "  $null = Invoke-Schtasks /delete /tn $Task /f",
      "  $code = Invoke-Schtasks /create /tn $Task /xml $Xml",
      "  if ($code -ne 0) {",
      `    Write-Warning "'$Task' was NOT registered (schtasks /create exit \${code}): $script:schtasksOutput"`,
      "    return $false",
      "  }",
      "  $code = Invoke-Schtasks /query /tn $Task",
      "  if ($code -ne 0) {",
      `    Write-Warning "'$Task' was NOT registered: schtasks /create reported success but the task cannot be queried."`,
      "    return $false",
      "  }",
      `  Write-Host "  + registered '$Task'"`,
      "  return $true",
      "}",
      "",
    );
  }

  for (const bv of input.vectors) {
    const task = windowsTaskName(bv.installer);
    lines.push(`# --- ${bv.vector.label} (${bv.installer.type}) ---`);
    if (!task) {
      lines.push(
        `Write-Warning "no task name for ${bv.installer.type}; install by hand (see README.txt)"`,
        "$failed++",
        "",
      );
      continue;
    }
    const xml = `$bundle\\vectors\\${bv.vector.slug}\\${bv.installer.filename}`;
    if (phase === "install") {
      lines.push(
        `if (-not (Register-MantisTask '${task.replace(/'/g, "''")}' "${xml}")) { $failed++ }`,
      );
    } else {
      lines.push(`schtasks /delete /tn "${task}" /f`);
    }
    lines.push("");
  }

  lines.push(
    "if ($failed -gt 0) {",
    '  Write-Host "done, with $failed vector(s) needing attention."',
    "  exit 2",
    "}",
    'Write-Host "done."',
    "",
  );

  return lines.join("\r\n");
}

/* -------------------------------------------------------------------------- */
/* README                                                                      */
/* -------------------------------------------------------------------------- */

function buildReadme(input: DeviceBundleInput): string {
  const script = input.os === "windows" ? "install.ps1" : "./install.sh";
  const out: string[] = [
    `mantis — device bundle for "${input.deviceName}" (${input.os})`,
    "",
    `${input.vectors.length} alarm(s), one key each, so a hit tells you which one fired.`,
    "",
    "QUICK START",
    input.os === "windows"
      ? "  Run in an ELEVATED PowerShell:\n    Set-ExecutionPolicy -Scope Process Bypass\n    .\\install.ps1"
      : `  chmod +x install.sh && ${script}`,
    "",
    "  Undo with the matching uninstall script.",
    "  Set MANTIS_ASSUME_YES=1 to skip the confirmation prompt.",
    "",
  ];
  if (input.os === "windows") {
    out.push(
      "  install.ps1 exits non-zero if any task fails to register; check with",
      '    schtasks /query /tn "<task name>"',
      "",
    );
  } else if (input.vectors.some(isPerUser)) {
    // Kept next to the quick start: which account gets the per-user alarms is
    // the one thing a root run (sudo, MDM) changes.
    if (input.os === "macos") {
      out.push(
        "  Run it as the account the per-user alarms (shell, sudo, LaunchAgents)",
        "  should watch; it asks for sudo itself where a vector needs root.",
        "  Run as root instead (sudo, MDM), it installs them for the account that",
        "  called sudo, or failing that the user logged in at the console.",
        "  Set MANTIS_TARGET_USER=<name> to choose (root included, if root's own",
        "  shells are what you want watched). With no such account it skips them",
        "  and exits non-zero rather than arm root's shells unasked.",
        "",
      );
    } else {
      out.push(
        "  Run it as the account the per-user alarms (shell, sudo) should watch;",
        "  it asks for sudo itself where a vector needs root.",
        "  Run as root instead, it installs them for the account that called",
        "  sudo - or for root itself when root is logged in directly, as on a",
        "  root-only server or container - and says which before it asks to",
        "  continue. Set MANTIS_TARGET_USER=<name> to choose another account.",
        "",
      );
    }
  }
  out.push("WHAT GETS INSTALLED", "");

  for (const bv of input.vectors) {
    out.push(
      `  ${bv.vector.label}  [${bv.installer.type}]`,
      `    ${bv.vector.blurb}`,
      `    key  : ${bv.key.memo}`,
      `    file : vectors/${bv.vector.slug}/${bv.installer.filename}`,
    );
    if (bv.vector.needsRoot) out.push("    needs: root");
    if (bv.vector.needsExtraSetup) {
      out.push(
        `    needs: ${bv.vector.needsExtraSetup.what} — ${bv.vector.needsExtraSetup.install.join(" && ")}`,
        `           ${bv.vector.needsExtraSetup.why}`,
      );
    }
    // The human-readable steps, kept verbatim so this file remains the manual
    // fallback if the bootstrap doesn't fit the host.
    out.push("    manual install:");
    for (const s of bv.installer.install) out.push(`      ${s}`);
    out.push("    manual uninstall:");
    for (const s of bv.installer.uninstall) out.push(`      ${s}`);
    if (bv.installer.notes) out.push(`    note : ${bv.installer.notes}`);
    out.push("");
  }

  if (input.baseUrl) {
    out.push(`Dashboard: ${input.baseUrl}/keys`, "");
  }
  return out.join("\n");
}

/* -------------------------------------------------------------------------- */
/* Quoting                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Device names and labels land inside double-quoted shell and PowerShell
 * strings in generated scripts. Neutralise the characters that would otherwise
 * end the string or start a substitution — a memo is operator-supplied text.
 */
function shq(s: string): string {
  return s.replace(/[\\"$`]/g, "");
}

function psq(s: string): string {
  return s.replace(/["`$]/g, "");
}

/** Escape a marker for use inside a sed address. */
function escapeSed(s: string): string {
  return s.replace(/[\\/&.*[\]^$]/g, "\\$&");
}
