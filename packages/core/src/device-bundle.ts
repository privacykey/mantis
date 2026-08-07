import JSZip from "jszip";
import type { DeviceOs, DeviceVector } from "./device-profiles.js";
import { normalizeDeviceName } from "./device-profiles.js";
import type { Installer } from "./installers.js";

/**
 * Builds the zip a device mint hands back: every vector's installer file, plus
 * a bootstrap that installs all of them and an uninstaller that removes them.
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
export function buildDeviceBundleFiles(input: DeviceBundleInput): BundleFiles {
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

export async function buildDeviceBundle(
  input: DeviceBundleInput,
): Promise<Buffer> {
  const bundle = buildDeviceBundleFiles(input);
  const zip = new JSZip();
  const dir = zip.folder(bundle.root);
  if (!dir) throw new Error("failed to create bundle root");

  for (const [path, content] of Object.entries(bundle.files)) {
    // 0o755 on the scripts so they're runnable straight out of the archive on
    // any extractor that preserves the mode (unzip, Finder, Nautilus).
    const executable =
      path === bundle.installScript || path === bundle.uninstallScript;
    dir.file(path, content, executable ? { unixPermissions: 0o755 } : {});
  }

  return zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
    platform: input.os === "windows" ? "DOS" : "UNIX",
  });
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
      const dest = type === "shell" ? "$HOME/.mantis.sh" : "$HOME/.mantis-sudo.sh";
      const { open, close } = rcMarkers(`${type}`);
      if (phase === "install") {
        return [
          `install -m 600 ${src} "${dest}"`,
          `for rc in $(mantis_rc_files); do`,
          `  if ! grep -qF '${open}' "$rc" 2>/dev/null; then`,
          `    printf '%s\\n' '' '${open}' '[ -f "${dest}" ] && . "${dest}"' '${close}' >> "$rc"`,
          `    say "  + sourced from $rc"`,
          `  else`,
          `    say "  = already sourced from $rc"`,
          `  fi`,
          `done`,
        ];
      }
      return [
        `for rc in $(mantis_rc_files); do`,
        `  [ -f "$rc" ] || continue`,
        // Delete the marked block inclusively. Exact markers mean we never
        // touch a line the operator wrote themselves.
        `  sed -i.mantis-bak '/${escapeSed(open)}/,/${escapeSed(close)}/d' "$rc" && rm -f "$rc.mantis-bak"`,
        `done`,
        `rm -f "${dest}"`,
      ];
    }

    case "macos-login":
    case "macos-network": {
      const dest = `$HOME/Library/LaunchAgents/${f}`;
      if (phase === "install") {
        return [
          `mkdir -p "$HOME/Library/LaunchAgents"`,
          // Unload first so re-running the bundle reloads cleanly instead of
          // failing with "service already loaded".
          `launchctl unload "${dest}" 2>/dev/null || true`,
          `install -m 644 ${src} "${dest}"`,
          `launchctl load "${dest}"`,
        ];
      }
      return [
        `launchctl unload "${dest}" 2>/dev/null || true`,
        `rm -f "${dest}"`,
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
          `if [ -e "$HOME/.wakeup" ] && ! grep -q 'X-Mantis-Source: macos-wake' "$HOME/.wakeup" 2>/dev/null; then`,
          `  say "  ! existing ~/.wakeup preserved as ~/.wakeup.pre-mantis"`,
          `  mv "$HOME/.wakeup" "$HOME/.wakeup.pre-mantis"`,
          `fi`,
          `install -m 755 ${src} "$HOME/.wakeup"`,
        ];
      }
      return [
        `rm -f "$HOME/.wakeup"`,
        `if [ -e "$HOME/.wakeup.pre-mantis" ]; then`,
        `  mv "$HOME/.wakeup.pre-mantis" "$HOME/.wakeup"`,
        `  say "  + restored your original ~/.wakeup"`,
        `fi`,
      ];
    }

    case "linux-boot":
    case "linux-wake": {
      const dest = `/etc/systemd/system/${f}`;
      if (phase === "install") {
        return [
          `$SUDO install -m 644 ${src} "${dest}"`,
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

function buildPosixScript(
  input: DeviceBundleInput,
  phase: "install" | "uninstall",
): string {
  const verb = phase === "install" ? "Install" : "Remove";
  const needsRoot = input.vectors.some((v) => v.vector.needsRoot);
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
    "# Which rc files to wire the shell hooks into. $SHELL is the login shell,",
    "# which is what a new terminal will actually read.",
    "mantis_rc_files() {",
    '  case "$(basename "${SHELL:-/bin/sh}")" in',
    '    zsh)  printf "%s\\n" "$HOME/.zshrc" ;;',
    '    bash) printf "%s\\n" "$HOME/.bashrc" ;;',
    '    *)    printf "%s\\n" "$HOME/.profile" ;;',
    "  esac",
    "}",
    "",
  );

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

    const extra = bv.vector.needsExtraSetup;
    if (extra && phase === "install") {
      lines.push(
        `if ! ${extra.detect} >/dev/null 2>&1; then`,
        `  say "  ! ${shq(extra.what)} is not installed — this alarm will not fire until it is."`,
        // Distinguish "you need to install X" from "you can't install X here":
        // suggesting `brew install …` on a machine with no Homebrew sends the
        // operator to a command that fails for an unrelated reason.
        `  if ${extra.requires.detect} >/dev/null 2>&1; then`,
        `    say "    ${shq(extra.install.join(" && "))}"`,
        `  else`,
        `    say "    ${shq(extra.what)} needs ${shq(extra.requires.label)}, which is not installed either."`,
        `  fi`,
        `  say "    ${shq(extra.why)}"`,
        `  FAILED=$((FAILED+1))`,
        `else`,
      );
    }

    for (const l of posixVectorBody(bv, phase)) lines.push(l);

    if (extra && phase === "install") lines.push("fi");
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
        // Delete first so re-running the bundle replaces the task instead of
        // failing with "task already exists".
        `schtasks /delete /tn "${task}" /f 2>$null | Out-Null`,
        `schtasks /create /tn "${task}" /xml "${xml}"`,
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
    "WHAT GETS INSTALLED",
    "",
  ];

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
