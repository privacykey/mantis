// Installer-snippet templates: install type → deployable snippet + human
// install/uninstall steps.
//
// Shared by the Next server (key install pages, device bundles) and the CLI
// (stateless edge URLs), which is why this module is framework-free and
// import-free: everything below is pure string templating. The CLI's edge
// path has no server-side keyId (UUID) — callers there derive a short id from
// the encrypted URL itself (see `deriveKeyIdFromUrl` in the CLI's
// `commands/edge.ts`) and pass it through the same `InstallerInput`.

export type InstallType =
  | "shell"
  | "shell-sudo"
  | "macos-login"
  | "macos-boot"
  | "macos-wake"
  | "macos-network"
  | "linux-boot"
  | "linux-wake"
  | "linux-network"
  | "windows-logon"
  | "windows-wake"
  | "windows-network"
  | "css-background"
  | "js-clone-detector"
  | "nfc-ndef"
  | "homeassistant"
  | "homeassistant-receiver"
  | "scrypted";

export type Installer = {
  type: InstallType;
  name: string;
  description: string;
  os: "macos" | "linux" | "windows" | "posix" | "web" | "tag" | "iot";
  filename: string;
  mime: string;
  content: string;
  install: string[];
  uninstall: string[];
  notes?: string;
  /**
   * homeassistant-receiver only: the webhook id this render embedded. Pass it
   * back as `InstallerInput.webhookId` to render the same file again.
   */
  webhookId?: string;
};

export type InstallerInput = {
  url: string;
  keyId: string;
  memo: string;
  /** Required for js-clone-detector; ignored elsewhere. */
  hostname?: string;
  /**
   * homeassistant-receiver only: the webhook id to embed (must satisfy
   * `isHomeAssistantWebhookId`). It is the only credential between Mantis and
   * Home Assistant, so when absent a random one is generated per call rather
   * than derived from anything the key discloses.
   */
  webhookId?: string;
};

export const ALL_INSTALL_TYPES: InstallType[] = [
  "shell",
  "shell-sudo",
  "macos-login",
  "macos-boot",
  "macos-wake",
  "macos-network",
  "linux-boot",
  "linux-wake",
  "linux-network",
  "windows-logon",
  "windows-wake",
  "windows-network",
  "css-background",
  "js-clone-detector",
  "nfc-ndef",
  "homeassistant",
  "homeassistant-receiver",
  "scrypted",
];

export const INSTALLER_META: Record<
  InstallType,
  { name: string; description: string; os: Installer["os"] }
> = {
  shell: {
    name: "Shell startup (POSIX)",
    description:
      "Snippet for .bashrc / .zshrc / .bash_profile. Fires on every shell launch — covers SSH logins.",
    os: "posix",
  },
  "shell-sudo": {
    name: "Sudo invocation (POSIX)",
    description:
      "Shell function that overrides `sudo` to ping the mantis before invoking the real sudo. Fires on every sudo within shells that source this snippet.",
    os: "posix",
  },
  "macos-login": {
    name: "macOS — user login",
    description:
      "LaunchAgent that fires once when you log in to the desktop. Per-user; no sudo required.",
    os: "macos",
  },
  "macos-boot": {
    name: "macOS — system boot",
    description:
      "LaunchDaemon that fires when the Mac boots, before any user logs in. Requires sudo to install.",
    os: "macos",
  },
  "macos-wake": {
    name: "macOS — wake from sleep",
    description:
      "Sleepwatcher hook (~/.wakeup) that fires when your Mac wakes. Requires `brew install sleepwatcher` and the sleepwatcher service running.",
    os: "macos",
  },
  "macos-network": {
    name: "macOS — network attach",
    description:
      "LaunchAgent that watches /private/var/run/resolv.conf and fires whenever DNS config changes (which happens on every network attach / Wi-Fi join).",
    os: "macos",
  },
  "linux-boot": {
    name: "Linux — system boot",
    description:
      "systemd unit that fires after network is up. Requires sudo to install.",
    os: "linux",
  },
  "linux-wake": {
    name: "Linux — wake from sleep",
    description:
      "systemd unit triggered by suspend/hibernate targets. Fires on resume.",
    os: "linux",
  },
  "linux-network": {
    name: "Linux — network attach",
    description:
      "NetworkManager dispatcher script at /etc/NetworkManager/dispatcher.d/99-mantis. Fires when an interface comes up.",
    os: "linux",
  },
  "windows-logon": {
    name: "Windows — user logon",
    description:
      "Task Scheduler XML that fires on any user logon. Import via Task Scheduler GUI or `schtasks /create /xml`.",
    os: "windows",
  },
  "windows-wake": {
    name: "Windows — wake from sleep",
    description:
      "Task Scheduler XML triggered by Power-Troubleshooter event 1 (system resumed). Fires on wake from sleep/hibernate.",
    os: "windows",
  },
  "windows-network": {
    name: "Windows — network attach",
    description:
      "Task Scheduler XML triggered by NetworkProfile/Operational event 10000 (network connected).",
    os: "windows",
  },
  "css-background": {
    name: "Web — CSS background canary",
    description:
      "CSS snippet that loads a 1×1 background image from the mantis URL. When someone copies your CSS to another site, the URL loads and fires the canary. Your own site loads it too, so declare your site's origin in the key's self_origins to have those hits ignored.",
    os: "web",
  },
  "js-clone-detector": {
    name: "Web — JavaScript clone detector",
    description:
      "JavaScript snippet that fires the canary only when the page hostname doesn't match the expected one. Detects when your site is cloned to another origin (phishing, scrapers).",
    os: "web",
  },
  "nfc-ndef": {
    name: "NFC tag (NDEF URL record)",
    description:
      "Write the key's URL to a blank NFC tag (NTAG213/215/216). When someone taps the tag with a phone, the OS opens the URL and the canary fires. The dashboard tags the hit with source=nfc. Bonus: download a printable sticker PDF with a QR fallback for non-NFC devices.",
    os: "tag",
  },
  homeassistant: {
    name: "Home Assistant automation bridge",
    description:
      "YAML snippet for a Home Assistant rest_command plus automation examples. Fires this mantis when a sensor, device, or automation event happens.",
    os: "iot",
  },
  "homeassistant-receiver": {
    name: "Home Assistant receiver (mantis → HA action)",
    description:
      "HA automation skeleton that listens for hits delivered via the home_assistant notification channel. Pair with `mantis dest add <key> home_assistant https://<ha>/api/webhook/<id>` to run an HA action (flip a switch, fire a scene, push a phone notification) whenever this mantis fires.",
    os: "iot",
  },
  scrypted: {
    name: "Scrypted smart-camera bridge",
    description:
      "Scrypted Script template that listens to selected device events and fires this mantis with structured smart-camera metadata.",
    os: "iot",
  },
};

function shortId(keyId: string): string {
  return keyId.slice(0, 8);
}

/**
 * Boot and wake alarms get one chance per event, and that event tends to
 * outrun the network or land on the trigger route's retryable 503. A single
 * request that fails fast (DNS, no route) is then a boot or resume nobody
 * hears about. Wrap the fire command in a bounded retry: five attempts,
 * backing off 5/10/15/20s — about a minute of waiting in total.
 *
 * Unrolled into an `||` chain rather than a loop: there is no counter to get
 * wrong, nothing that can spin forever, and no `$variable` for systemd's
 * ExecStart substitution to rewrite.
 */
const FIRE_RETRY_DELAYS = [5, 10, 15, 20];

function shRetry(fire: string): string {
  return [
    fire,
    ...FIRE_RETRY_DELAYS.map((s) => `{ sleep ${s}; ${fire}; }`),
  ].join(" || ");
}

function buildShell({ url }: InstallerInput): Installer {
  const content = `# mantis: fires on shell startup (covers ssh logins)
# Generated by mantis — paste into ~/.bashrc, ~/.zshrc, or ~/.bash_profile.
# tty must be read in the foreground: the backgrounded curl's stdin is /dev/null.
_mantis_tty=$(tty 2>/dev/null) || _mantis_tty=
(curl -fsS -m 3 -o /dev/null \\
  -H "X-Mantis-Source: shell" \\
  -H "X-Mantis-User: \${USER:-unknown}" \\
  -H "X-Mantis-Host: $(hostname 2>/dev/null || echo unknown)" \\
  -H "X-Mantis-SSH-Client: \${SSH_CLIENT:-}" \\
  -H "X-Mantis-SSH-Connection: \${SSH_CONNECTION:-}" \\
  -H "X-Mantis-TTY: \${_mantis_tty:-}" \\
  "${url}" >/dev/null 2>&1 &) 2>/dev/null
unset _mantis_tty
`;
  return {
    type: "shell",
    name: INSTALLER_META.shell.name,
    description: INSTALLER_META.shell.description,
    os: "posix",
    filename: "mantis.sh",
    mime: "text/x-shellscript; charset=utf-8",
    content,
    install: [
      "# Append to your shell rc file:",
      "echo 'source ~/.mantis.sh' >> ~/.zshrc   # or ~/.bashrc",
      "mv mantis.sh ~/.mantis.sh",
    ],
    uninstall: [
      "# Remove the 'source ~/.mantis.sh' line from ~/.zshrc / ~/.bashrc",
      "rm ~/.mantis.sh",
    ],
    notes:
      "Backgrounded + 3s timeout — won't block your shell. Captures $USER, hostname, $SSH_CLIENT (SSH client IP if applicable), and tty.",
  };
}

function buildMacosLogin(input: InstallerInput): Installer {
  const label = `com.mantis.login.${shortId(input.keyId)}`;
  // sh -c form so we can interpolate $USER / $(hostname) at runtime.
  const shCmd = `/usr/bin/curl -fsS -m 5 -o /dev/null \
-H "X-Mantis-Source: macos-login" \
-H "X-Mantis-User: $USER" \
-H "X-Mantis-Host: $(hostname)" \
"${input.url}"`;
  const content = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>${label}</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/sh</string>
        <string>-c</string>
        <string>${escapeXml(shCmd)}</string>
    </array>
    <key>RunAtLoad</key><true/>
    <key>StandardOutPath</key><string>/dev/null</string>
    <key>StandardErrorPath</key><string>/dev/null</string>
</dict>
</plist>
`;
  return {
    type: "macos-login",
    name: INSTALLER_META["macos-login"].name,
    description: INSTALLER_META["macos-login"].description,
    os: "macos",
    filename: `${label}.plist`,
    mime: "application/xml",
    content,
    install: [
      `mv ${label}.plist ~/Library/LaunchAgents/`,
      `launchctl load ~/Library/LaunchAgents/${label}.plist`,
    ],
    uninstall: [
      `launchctl unload ~/Library/LaunchAgents/${label}.plist`,
      `rm ~/Library/LaunchAgents/${label}.plist`,
    ],
    notes: "Captures $USER and hostname. No SSH context (this fires at GUI login, not SSH).",
  };
}

function buildMacosBoot(input: InstallerInput): Installer {
  const label = `com.mantis.boot.${shortId(input.keyId)}`;
  const shCmd = `mantis_fire() { /usr/bin/curl -fsS -m 10 -o /dev/null \
-H "X-Mantis-Source: macos-boot" \
-H "X-Mantis-Host: $(hostname)" \
"${input.url}"; }; ${shRetry("mantis_fire")}`;
  const content = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>${label}</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/sh</string>
        <string>-c</string>
        <string>${escapeXml(shCmd)}</string>
    </array>
    <key>RunAtLoad</key><true/>
    <key>StandardOutPath</key><string>/dev/null</string>
    <key>StandardErrorPath</key><string>/dev/null</string>
</dict>
</plist>
`;
  return {
    type: "macos-boot",
    name: INSTALLER_META["macos-boot"].name,
    description: INSTALLER_META["macos-boot"].description,
    os: "macos",
    filename: `${label}.plist`,
    mime: "application/xml",
    content,
    install: [
      `sudo mv ${label}.plist /Library/LaunchDaemons/`,
      `sudo chown root:wheel /Library/LaunchDaemons/${label}.plist`,
      `sudo launchctl load /Library/LaunchDaemons/${label}.plist`,
    ],
    uninstall: [
      `sudo launchctl unload /Library/LaunchDaemons/${label}.plist`,
      `sudo rm /Library/LaunchDaemons/${label}.plist`,
    ],
    notes:
      "Boots before any user logs in (no $USER yet). The network is often not up yet at that point, so the ping retries up to 5 times over about a minute. Captures hostname only.",
  };
}

/**
 * The unit runs as root, so it must not stay owned by whoever downloaded it:
 * `mv` keeps the file's owner and mode, and that account could then rewrite a
 * root-run ExecStart without sudo. `install` writes a fresh root-owned copy.
 */
function systemdUnitInstallSteps(unitName: string): string[] {
  return [
    `sudo install -o root -g root -m 0644 ${unitName} /etc/systemd/system/${unitName}`,
    `rm ${unitName}`,
    `sudo systemctl daemon-reload`,
    `sudo systemctl enable ${unitName}`,
  ];
}

function buildLinuxBoot(input: InstallerInput): Installer {
  const unitName = `mantis-${shortId(input.keyId)}.service`;
  // systemd ExecStart with sh -c so we can interpolate $(hostname).
  // Single quote the whole sh -c arg; use double quotes inside for header values.
  //
  // Type=simple, not oneshot. multi-user.target is ordered after every unit it
  // wants, and a oneshot only counts as started once it has exited, so the
  // retry chain (up to ~100s against an unreachable server) would hold the
  // boot at that target. A simple service counts as started as soon as it is
  // forked; the retries then run alongside the rest of the boot.
  const content = `[Unit]
Description=Mantis boot ping for key ${input.keyId}
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/bin/sh -c 'mantis_fire() { /usr/bin/curl -fsS -m 10 -o /dev/null -H "X-Mantis-Source: linux-boot" -H "X-Mantis-Host: $(hostname)" "${input.url}"; }; ${shRetry("mantis_fire")}'

[Install]
WantedBy=multi-user.target
`;
  return {
    type: "linux-boot",
    name: INSTALLER_META["linux-boot"].name,
    description: INSTALLER_META["linux-boot"].description,
    os: "linux",
    filename: unitName,
    mime: "text/plain; charset=utf-8",
    content,
    install: systemdUnitInstallSteps(unitName),
    uninstall: [
      `sudo systemctl disable ${unitName}`,
      `sudo rm /etc/systemd/system/${unitName}`,
      `sudo systemctl daemon-reload`,
    ],
    notes:
      "Captures hostname (no $USER at boot time). Retries up to 5 times over about a minute if the request fails; the retries run in the background, so an unreachable server does not hold up the boot.",
  };
}

/**
 * BUILTIN\Users. With a group principal Task Scheduler runs the action in the
 * session of the group member the trigger is for — here, whichever account
 * just logged on — as that account and with no added privilege.
 */
const WINDOWS_PRINCIPAL_USERS = "<GroupId>S-1-5-32-545</GroupId>";

/**
 * NT AUTHORITY\LOCAL SERVICE. Wake and network-attach belong to the machine,
 * not to a session, so these run whether or not anyone is logged on. LOCAL
 * SERVICE is the least-privileged built-in account that can still make an
 * outbound request; nothing here needs SYSTEM.
 */
const WINDOWS_PRINCIPAL_LOCAL_SERVICE = "<UserId>S-1-5-19</UserId>";

type WindowsTask = {
  description: string;
  /** The single child of <Triggers>, indented to match. */
  trigger: string;
  /** One of the WINDOWS_PRINCIPAL_* elements. */
  principal: string;
  /**
   * Start a new instance even while an earlier one is still running (the
   * schema default, IgnoreNew, drops that trigger).
   */
  parallel?: boolean;
  /** xs:duration; has to outlast the action, retries included. */
  executionTimeLimit: string;
  psCommand: string;
};

/**
 * Task Scheduler task definition (schema 1.2) shared by the Windows alarms.
 *
 * - The XML declaration names no encoding. Every writer — CLI, zip, HTTP
 *   download — emits this string as BOM-less UTF-8, and a declaration that
 *   says otherwise makes a conformant parser reject the file. Without one the
 *   bytes speak for themselves: UTF-8, or UTF-16 if a tool re-saves the file
 *   with a BOM.
 * - Element names are the task schema's, not the New-ScheduledTaskSettingsSet
 *   switches: the battery settings are DisallowStartIfOnBatteries and
 *   StopIfGoingOnBatteries, both false so a laptop on battery still fires.
 * - The principal is always explicit. Left out, Task Scheduler binds the task
 *   to whoever registered it, and the alarm then only fires inside that one
 *   admin's session.
 * - Children are in the order Task Scheduler itself exports them.
 */
function windowsTaskXml(task: WindowsTask): string {
  const multipleInstances = task.parallel
    ? "    <MultipleInstancesPolicy>Parallel</MultipleInstancesPolicy>\n"
    : "";
  return `<?xml version="1.0"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Author>mantis</Author>
    <Description>${escapeXml(task.description)}</Description>
  </RegistrationInfo>
  <Triggers>
${task.trigger}
  </Triggers>
  <Principals>
    <Principal id="Author">
      ${task.principal}
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
${multipleInstances}    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <Hidden>true</Hidden>
    <ExecutionTimeLimit>${task.executionTimeLimit}</ExecutionTimeLimit>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>powershell.exe</Command>
      <Arguments>-WindowStyle Hidden -NoProfile -Command "${escapeXml(task.psCommand)}"</Arguments>
    </Exec>
  </Actions>
</Task>
`;
}

function buildWindowsLogon(input: InstallerInput): Installer {
  const id = shortId(input.keyId);
  const psUrl = input.url.replace(/'/g, "''");
  // PowerShell hashtable for headers; @{key='val';...} syntax.
  const psCommand = `try { $h = @{'X-Mantis-Source'='windows-logon'; 'X-Mantis-User'=$env:USERNAME; 'X-Mantis-Host'=$env:COMPUTERNAME}; Invoke-WebRequest -Uri '${psUrl}' -Headers $h -UseBasicParsing -TimeoutSec 5 | Out-Null } catch {}`;
  const content = windowsTaskXml({
    description: `Mantis logon ping (${id})`,
    trigger: `    <LogonTrigger>
      <Enabled>true</Enabled>
    </LogonTrigger>`,
    principal: WINDOWS_PRINCIPAL_USERS,
    // Two accounts logging on within seconds of each other are two events.
    parallel: true,
    executionTimeLimit: "PT30S",
    psCommand,
  });
  return {
    type: "windows-logon",
    name: INSTALLER_META["windows-logon"].name,
    description: INSTALLER_META["windows-logon"].description,
    os: "windows",
    filename: `mantis-logon-${id}.xml`,
    mime: "application/xml",
    content,
    install: [
      `# Run in an elevated PowerShell:`,
      `schtasks /create /tn "Mantis Logon ${id}" /xml mantis-logon-${id}.xml`,
    ],
    uninstall: [`schtasks /delete /tn "Mantis Logon ${id}" /f`],
    notes:
      "Runs as the BUILTIN\\Users group, so it fires in the session of whichever account logs on (not only the admin who registered it). Captures that account's $env:USERNAME and $env:COMPUTERNAME.",
  };
}

function buildShellSudo({ url }: InstallerInput): Installer {
  const content = `# mantis: fires when 'sudo' is invoked from a shell that sourced this file.
# Generated by mantis — paste into ~/.bashrc / ~/.zshrc.
sudo() {
  # tty must be read in the foreground: the backgrounded curl's stdin is /dev/null.
  _mantis_tty=$(tty 2>/dev/null) || _mantis_tty=
  (curl -fsS -m 3 -o /dev/null \\
    -H "X-Mantis-Source: shell-sudo" \\
    -H "X-Mantis-User: \${USER:-unknown}" \\
    -H "X-Mantis-Host: $(hostname 2>/dev/null || echo unknown)" \\
    -H "X-Mantis-SSH-Client: \${SSH_CLIENT:-}" \\
    -H "X-Mantis-TTY: \${_mantis_tty:-}" \\
    -H "X-Mantis-Sudo-Cmd: $*" \\
    "${url}" >/dev/null 2>&1 &) 2>/dev/null
  unset _mantis_tty
  command sudo "$@"
}
`;
  return {
    type: "shell-sudo",
    name: INSTALLER_META["shell-sudo"].name,
    description: INSTALLER_META["shell-sudo"].description,
    os: "posix",
    filename: "mantis-sudo.sh",
    mime: "text/x-shellscript; charset=utf-8",
    content,
    install: [
      "mv mantis-sudo.sh ~/.mantis-sudo.sh",
      "echo 'source ~/.mantis-sudo.sh' >> ~/.zshrc   # or ~/.bashrc",
    ],
    uninstall: [
      "# Remove the 'source ~/.mantis-sudo.sh' line from ~/.zshrc / ~/.bashrc",
      "rm ~/.mantis-sudo.sh",
    ],
    notes:
      "Only fires when sudo is called from a shell that sourced this snippet. Sudo invoked by daemons or GUI tools is not captured. Sends X-Mantis-Sudo-Cmd with the original sudo arguments, plus the invoking tty.",
  };
}

function buildMacosWake({ url }: InstallerInput): Installer {
  const content = `#!/bin/sh
# mantis: ~/.wakeup hook for sleepwatcher
# Fires when the Mac wakes from sleep. The network is rarely back the instant
# the machine resumes, so the ping retries (5 attempts, about a minute) in the
# background rather than holding sleepwatcher up while it waits.
mantis_fire() {
  /usr/bin/curl -fsS -m 5 -o /dev/null \\
    -H "X-Mantis-Source: macos-wake" \\
    -H "X-Mantis-User: $USER" \\
    -H "X-Mantis-Host: $(hostname)" \\
    "${url}"
}
(${shRetry("mantis_fire")}) >/dev/null 2>&1 &
`;
  return {
    type: "macos-wake",
    name: INSTALLER_META["macos-wake"].name,
    description: INSTALLER_META["macos-wake"].description,
    os: "macos",
    filename: "mantis-wakeup.sh",
    mime: "text/x-shellscript; charset=utf-8",
    content,
    install: [
      "# 1. Install sleepwatcher (one-time):",
      "brew install sleepwatcher",
      "brew services start sleepwatcher",
      "",
      "# 2. Install the wake hook:",
      "mv mantis-wakeup.sh ~/.wakeup",
      "chmod +x ~/.wakeup",
    ],
    uninstall: ["rm ~/.wakeup"],
    notes:
      "Requires sleepwatcher (Homebrew). macOS has no built-in user-space wake hook; sleepwatcher fills that gap with ~/.sleep and ~/.wakeup scripts. Retries up to 5 times over about a minute while the network comes back.",
  };
}

function buildMacosNetwork(input: InstallerInput): Installer {
  const label = `com.mantis.network.${shortId(input.keyId)}`;
  const shCmd = `/usr/bin/curl -fsS -m 5 -o /dev/null \
-H "X-Mantis-Source: macos-network" \
-H "X-Mantis-User: $USER" \
-H "X-Mantis-Host: $(hostname)" \
"${input.url}"`;
  const content = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>${label}</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/sh</string>
        <string>-c</string>
        <string>${escapeXml(shCmd)}</string>
    </array>
    <key>WatchPaths</key>
    <array>
        <string>/private/var/run/resolv.conf</string>
    </array>
    <key>RunAtLoad</key><false/>
    <key>StandardOutPath</key><string>/dev/null</string>
    <key>StandardErrorPath</key><string>/dev/null</string>
</dict>
</plist>
`;
  return {
    type: "macos-network",
    name: INSTALLER_META["macos-network"].name,
    description: INSTALLER_META["macos-network"].description,
    os: "macos",
    filename: `${label}.plist`,
    mime: "application/xml",
    content,
    install: [
      `mv ${label}.plist ~/Library/LaunchAgents/`,
      `launchctl load ~/Library/LaunchAgents/${label}.plist`,
    ],
    uninstall: [
      `launchctl unload ~/Library/LaunchAgents/${label}.plist`,
      `rm ~/Library/LaunchAgents/${label}.plist`,
    ],
    notes:
      "Triggered by changes to /private/var/run/resolv.conf, which macOS rewrites on every network attach (Wi-Fi join, ethernet plug, VPN connect).",
  };
}

function buildLinuxWake(input: InstallerInput): Installer {
  const unitName = `mantis-wake-${shortId(input.keyId)}.service`;
  // Stays Type=oneshot, unlike the boot unit: this one is ordered After= the
  // sleep targets that want it, so systemd adds no ordering the other way and
  // nothing waits for the retry chain to finish.
  const content = `[Unit]
Description=Mantis wake ping for key ${input.keyId}
After=suspend.target hibernate.target hybrid-sleep.target network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/bin/sh -c 'mantis_fire() { /usr/bin/curl -fsS -m 10 -o /dev/null -H "X-Mantis-Source: linux-wake" -H "X-Mantis-Host: $(hostname)" "${input.url}"; }; ${shRetry("mantis_fire")}'

[Install]
WantedBy=suspend.target hibernate.target hybrid-sleep.target
`;
  return {
    type: "linux-wake",
    name: INSTALLER_META["linux-wake"].name,
    description: INSTALLER_META["linux-wake"].description,
    os: "linux",
    filename: unitName,
    mime: "text/plain; charset=utf-8",
    content,
    install: systemdUnitInstallSteps(unitName),
    uninstall: [
      `sudo systemctl disable ${unitName}`,
      `sudo rm /etc/systemd/system/${unitName}`,
      `sudo systemctl daemon-reload`,
    ],
    notes:
      "WantedBy the sleep targets means systemd starts this unit when the system *resumes* from those states. The network is rarely back at that instant, so the ping retries up to 5 times over about a minute.",
  };
}

function buildLinuxNetwork({ url, keyId }: InstallerInput): Installer {
  const id = shortId(keyId);
  const content = `#!/bin/sh
# /etc/NetworkManager/dispatcher.d/99-mantis-${id}
# Fires when a network interface comes up.
IFACE="$1"
ACTION="$2"
if [ "$ACTION" = "up" ]; then
    /usr/bin/curl -fsS -m 5 -o /dev/null \\
      -H "X-Mantis-Source: linux-network" \\
      -H "X-Mantis-Host: $(hostname)" \\
      -H "X-Mantis-Network-Interface: $IFACE" \\
      "${url}" &
fi
`;
  return {
    type: "linux-network",
    name: INSTALLER_META["linux-network"].name,
    description: INSTALLER_META["linux-network"].description,
    os: "linux",
    filename: `99-mantis-${id}`,
    mime: "text/x-shellscript; charset=utf-8",
    content,
    install: [
      `sudo mv 99-mantis-${id} /etc/NetworkManager/dispatcher.d/`,
      `sudo chown root:root /etc/NetworkManager/dispatcher.d/99-mantis-${id}`,
      `sudo chmod 755 /etc/NetworkManager/dispatcher.d/99-mantis-${id}`,
    ],
    uninstall: [
      `sudo rm /etc/NetworkManager/dispatcher.d/99-mantis-${id}`,
    ],
    notes:
      "Requires NetworkManager (most desktop distros). For systemd-networkd-only systems, use a different hook (not generated here).",
  };
}

function buildWindowsWake(input: InstallerInput): Installer {
  const id = shortId(input.keyId);
  const psUrl = input.url.replace(/'/g, "''");
  // One resume, one chance: the network is rarely back the instant the machine
  // wakes, so try up to 5 times, waiting 5/10/15/20s between attempts (the
  // same schedule as shRetry) and stopping at the first success. No
  // X-Mantis-User: the task runs as LOCAL SERVICE, which is not a person.
  const retryWaits = [0, ...FIRE_RETRY_DELAYS].join(",");
  const psCommand = `$h = @{'X-Mantis-Source'='windows-wake'; 'X-Mantis-Host'=$env:COMPUTERNAME}; foreach ($wait in ${retryWaits}) { Start-Sleep -Seconds $wait; try { Invoke-WebRequest -Uri '${psUrl}' -Headers $h -UseBasicParsing -TimeoutSec 5 | Out-Null; break } catch {} }`;
  const content = windowsTaskXml({
    description: `Mantis wake ping (${id})`,
    trigger: `    <EventTrigger>
      <Enabled>true</Enabled>
      <Subscription>${escapeXml(`<QueryList><Query Id="0" Path="System"><Select Path="System">*[System[Provider[@Name='Microsoft-Windows-Power-Troubleshooter'] and (EventID=1)]]</Select></Query></QueryList>`)}</Subscription>
    </EventTrigger>`,
    principal: WINDOWS_PRINCIPAL_LOCAL_SERVICE,
    // A resume that arrives while an earlier one is still retrying is its own
    // event, not one to drop.
    parallel: true,
    // 50s of waits plus five 5s attempts, with room for PowerShell to start.
    executionTimeLimit: "PT3M",
    psCommand,
  });
  return {
    type: "windows-wake",
    name: INSTALLER_META["windows-wake"].name,
    description: INSTALLER_META["windows-wake"].description,
    os: "windows",
    filename: `mantis-wake-${id}.xml`,
    mime: "application/xml",
    content,
    install: [
      `# Run in an elevated PowerShell:`,
      `schtasks /create /tn "Mantis Wake ${id}" /xml mantis-wake-${id}.xml`,
    ],
    uninstall: [`schtasks /delete /tn "Mantis Wake ${id}" /f`],
    notes:
      "Triggers on System log event 1 from Microsoft-Windows-Power-Troubleshooter, which fires whenever the system resumes from sleep/hibernate. Runs as LOCAL SERVICE, so it fires whether or not anyone is logged on, and retries up to 5 times over about a minute while the network comes back. Captures $env:COMPUTERNAME only.",
  };
}

function buildWindowsNetwork(input: InstallerInput): Installer {
  const id = shortId(input.keyId);
  const psUrl = input.url.replace(/'/g, "''");
  // No X-Mantis-User: the task runs as LOCAL SERVICE, which is not a person.
  const psCommand = `try { $h = @{'X-Mantis-Source'='windows-network'; 'X-Mantis-Host'=$env:COMPUTERNAME}; Invoke-WebRequest -Uri '${psUrl}' -Headers $h -UseBasicParsing -TimeoutSec 5 | Out-Null } catch {}`;
  const content = windowsTaskXml({
    description: `Mantis network-attach ping (${id})`,
    trigger: `    <EventTrigger>
      <Enabled>true</Enabled>
      <Subscription>${escapeXml(`<QueryList><Query Id="0" Path="Microsoft-Windows-NetworkProfile/Operational"><Select Path="Microsoft-Windows-NetworkProfile/Operational">*[System[(EventID=10000)]]</Select></Query></QueryList>`)}</Subscription>
    </EventTrigger>`,
    principal: WINDOWS_PRINCIPAL_LOCAL_SERVICE,
    executionTimeLimit: "PT30S",
    psCommand,
  });
  return {
    type: "windows-network",
    name: INSTALLER_META["windows-network"].name,
    description: INSTALLER_META["windows-network"].description,
    os: "windows",
    filename: `mantis-network-${id}.xml`,
    mime: "application/xml",
    content,
    install: [
      `# Run in an elevated PowerShell:`,
      `schtasks /create /tn "Mantis Network ${id}" /xml mantis-network-${id}.xml`,
    ],
    uninstall: [`schtasks /delete /tn "Mantis Network ${id}" /f`],
    notes:
      "Triggers on Microsoft-Windows-NetworkProfile/Operational event 10000, which fires when a network profile is connected (Wi-Fi join, Ethernet plug-in, VPN up). Runs as LOCAL SERVICE, so it fires whether or not anyone is logged on. Captures $env:COMPUTERNAME only.",
  };
}

function buildCssBackground({ url, memo }: InstallerInput): Installer {
  // Replace a random third of the URL's lowercase letters (scheme, host and
  // path alike) with CSS hex escapes, the way canarytokens.org does, so the
  // URL is less obvious to someone glancing at the stylesheet. Keep this rough
  // — the goal is "harder to read", not "impossible to read".
  //
  // The escape must decode to exactly the letter it replaced. A CSS hex escape
  // takes up to six hex digits and then swallows one following whitespace
  // (CSS Syntax 3 §4.3.7), so a short one such as \6d followed by "a" reads as
  // U+06DA and the url() points somewhere else. Padding every escape to six
  // digits leaves nothing for the next character to be absorbed into, and a
  // letter that is followed by whitespace is left unescaped.
  const obfuscated = url.replace(/[a-z](?!\s)/g, (ch) => {
    return Math.random() < 0.35
      ? "\\" + ch.charCodeAt(0).toString(16).padStart(6, "0")
      : ch;
  });
  const content = `/*
 * Mantis canary CSS — fires when the stylesheet is rendered.
 * Generated for: ${memo}
 *
 * Paste into your site's stylesheet (or a <style> block). When someone
 * copies your CSS to another site, the URL loads and fires the canary.
 * Your own site loads it too: declare your site's origin (for example
 * https://www.example.com) in this key's self_origins so those hits are
 * ignored and only other sites alert.
 */
body {
  background-image: url('${obfuscated}') !important;
}
`;
  return {
    type: "css-background",
    name: INSTALLER_META["css-background"].name,
    description: INSTALLER_META["css-background"].description,
    os: "web",
    filename: "mantis-canary.css",
    mime: "text/css; charset=utf-8",
    content,
    install: [
      "# Paste into your site's stylesheet, or include as an external file:",
      "<link rel=\"stylesheet\" href=\"/mantis-canary.css\">",
    ],
    uninstall: ["# Remove the CSS rule from your stylesheet."],
    notes:
      "URL is partially obfuscated with six-digit CSS escape sequences (\\00006c, \\000072, etc.), which decode back to the trigger URL. The canary returns a 1×1 transparent GIF so the background is visually invisible. Your own site fires this key on every page view, so declare your site's origin (for example https://www.example.com) in the key's self_origins — the `self_origins` API field, or the key's settings in the dashboard — and hits whose Referer is that origin are ignored. Without it, own-site traffic fills the dedupe window and most clone hits never alert. The exclusion needs your pages to send at least an origin Referer: the browser default does; `Referrer-Policy: no-referrer` or `same-origin` does not. A clone that hot-links your stylesheet instead of copying it reports your origin as its Referer and is not detected.",
  };
}

/**
 * Reduce whatever the operator typed for "expected hostname" to the form
 * `window.location.hostname` takes: lowercase, no scheme, userinfo, port,
 * path or trailing dot. The generated snippet compares strings, so an
 * un-normalised value ("Own-Site.test", "https://own-site.test/") would never
 * match and the detector would fire on the operator's own site.
 */
function normalizeExpectedHostname(raw: string | undefined): string {
  // Plain scanning rather than open-ended patterns: the value is free text,
  // and a pattern that can backtrack over it is quadratic on a hostile input.
  let h = (raw ?? "").trim().toLowerCase();
  const scheme = /^[a-z][a-z0-9+.-]*:\/\//.exec(h);
  if (scheme) h = h.slice(scheme[0].length);
  if (h.startsWith("//")) h = h.slice(2);
  // Path, query and fragment.
  for (let i = 0; i < h.length; i++) {
    if (h[i] === "/" || h[i] === "?" || h[i] === "#") {
      h = h.slice(0, i);
      break;
    }
  }
  // Userinfo.
  h = h.slice(h.lastIndexOf("@") + 1);
  // Port. A bracketed IPv6 literal keeps its brackets, as location.hostname does.
  const isPort = (s: string) => /^\d*$/.test(s);
  if (h.startsWith("[")) {
    const close = h.indexOf("]");
    if (close !== -1 && h[close + 1] === ":" && isPort(h.slice(close + 2))) {
      h = h.slice(0, close + 1);
    }
  } else {
    const colon = h.indexOf(":");
    if (colon !== -1 && isPort(h.slice(colon + 1))) h = h.slice(0, colon);
  }
  // Trailing dots.
  let end = h.length;
  while (end > 0 && h[end - 1] === ".") end--;
  return h.slice(0, end).trim();
}

function buildJsCloneDetector({ url, memo, hostname }: InstallerInput): Installer {
  const expected = normalizeExpectedHostname(hostname);
  const expectedJs = JSON.stringify(expected);
  const urlJs = JSON.stringify(url);
  const content = `/*
 * Mantis canary clone detector — fires when this script runs on a hostname
 * other than the expected one. Generated for: ${memo}
 * Expected hostname: ${expected || "(none — fires everywhere)"}
 *
 * Paste in a <script> tag on every page you want to protect against cloning.
 * The hit records the Referer (and the explicit l=/r= query params) so you
 * can see WHERE your site was cloned to.
 */
(function () {
  var expected = ${expectedJs};
  var h = (window.location.hostname || "").toLowerCase().replace(/\\.$/, "");
  if (expected && (h === expected || h.endsWith("." + expected))) return;
  var img = new Image();
  var canary = ${urlJs};
  var sep = canary.indexOf("?") >= 0 ? "&" : "?";
  img.src =
    canary + sep +
    "l=" + encodeURIComponent(window.location.href) +
    "&r=" + encodeURIComponent(document.referrer || "");
})();
`;
  return {
    type: "js-clone-detector",
    name: INSTALLER_META["js-clone-detector"].name,
    description: INSTALLER_META["js-clone-detector"].description,
    os: "web",
    filename: "mantis-clone-detector.js",
    mime: "application/javascript; charset=utf-8",
    content,
    install: [
      "# Include in your site, e.g.:",
      "<script src=\"/mantis-clone-detector.js\"></script>",
      "# Or inline the snippet inside a <script>...</script> block.",
    ],
    uninstall: ["# Remove the script tag / inline block from your pages."],
    notes:
      expected
        ? `Only fires when window.location.hostname is neither "${expected}" nor a subdomain of it. Sends location.href and document.referrer as query params so you can identify the cloning site.`
        : "No expected hostname configured — this snippet will fire on ALL hostnames including your own. Pass --hostname or set the field in the dashboard to enable origin filtering.",
  };
}

function buildNfcNdef({ url, memo }: InstallerInput): Installer {
  const taggedUrl = appendSrc(url, "nfc");
  const content = `# Mantis NFC tag — ${memo}
#
# Write this URL to a blank NFC tag (NTAG213/215/216) using any NFC-write app
# (NFC Tools on Android/iOS, NXP TagWriter on Android, Apple Shortcuts on iOS).
# When someone taps the tag with a phone, their browser opens the URL and the
# canary fires. The ?src=nfc query param tags the hit so the dashboard shows
# it came from an NFC tap (vs. a typed URL or a different installer).
#
${taggedUrl}
`;
  return {
    type: "nfc-ndef",
    name: INSTALLER_META["nfc-ndef"].name,
    description: INSTALLER_META["nfc-ndef"].description,
    os: "tag",
    filename: "mantis-nfc-url.txt",
    mime: "text/plain; charset=utf-8",
    content,
    install: [
      "# 1. Buy a blank NFC tag (NTAG213/215/216 — ~$0.20–$1 each in bulk).",
      "# 2. Install an NFC writer on your phone (NFC Tools is free, available on",
      "#    both stores). iOS users: use the Apple Shortcuts 'Write to NFC tag' action.",
      "# 3. In the app, choose Write → Add record → URL.",
      `# 4. Paste:  ${taggedUrl}`,
      "# 5. Hold the tag against the phone's NFC area to write.",
      "",
      "# Optional — printable sticker PDF (QR fallback for non-NFC devices):",
      "#   GET /api/keys/<key-id>/download?format=nfc-label",
      "#   Or in the dashboard: key detail page → 'NFC label (PDF)' link.",
    ],
    uninstall: [
      "# Discard the tag, or rewrite it with a different URL.",
    ],
    notes:
      "Cross-platform — the OS opens the URL in the default browser on tap. No app installation required by the target. For high-surface deployment, write multiple tags with the same URL.",
  };
}

function buildHomeAssistant({ url, memo }: InstallerInput): Installer {
  const content = `# Mantis Home Assistant bridge — ${memo}
#
# Paste the rest_command block into configuration.yaml, then adapt one or more
# automation examples below. Restart Home Assistant or reload YAML after adding
# rest_command.
#
# Mantis will record these headers as structured event context:
#   X-Mantis-Source, X-Mantis-Event, X-Mantis-Device, X-Mantis-Entity-Id,
#   X-Mantis-Automation, X-Mantis-Area

rest_command:
  mantis_iot_event:
    url: "${url}"
    method: POST
    timeout: 5
    content_type: "application/json"
    headers:
      X-Mantis-Source: "homeassistant"
      X-Mantis-Event: "{{ event | default('homeassistant-event') }}"
      X-Mantis-Device: "{{ device | default('') }}"
      X-Mantis-Entity-Id: "{{ entity_id | default('') }}"
      X-Mantis-Automation: "{{ automation | default('') }}"
      X-Mantis-Area: "{{ area | default('') }}"
    payload: >-
      {{ payload | default({}) | to_json }}

automation:
  - alias: "Mantis - front door opened"
    mode: single
    triggers:
      - trigger: state
        entity_id: binary_sensor.front_door_contact
        to: "on"
    actions:
      - action: rest_command.mantis_iot_event
        data:
          event: "door-opened"
          device: "{{ state_attr(trigger.entity_id, 'friendly_name') or trigger.entity_id }}"
          entity_id: "{{ trigger.entity_id }}"
          area: "{{ area_name(trigger.entity_id) or '' }}"
          automation: "Mantis - front door opened"
          payload:
            from: "{{ trigger.from_state.state if trigger.from_state else '' }}"
            to: "{{ trigger.to_state.state if trigger.to_state else '' }}"

  - alias: "Mantis - automation triggered"
    mode: queued
    max: 10
    triggers:
      - trigger: event
        event_type: automation_triggered
    conditions:
      # Never bridge a Mantis automation's own run: not this automation, not
      # the examples in this file, and not the "Mantis hit" receiver that
      # Mantis itself calls. Each of those already is, or was caused by, a
      # Mantis request; bridging it would turn every POST into another one.
      # If you rename one, keep its "Mantis" prefix or extend this condition.
      - condition: template
        value_template: >-
          {{ trigger.event.data.entity_id != this.entity_id
          and not (trigger.event.data.name | default('', true) | string | lower).startswith('mantis')
          and not (trigger.event.data.entity_id | default('', true) | string).startswith('automation.mantis_') }}
    actions:
      - action: rest_command.mantis_iot_event
        data:
          event: "automation-triggered"
          automation: "{{ trigger.event.data.name or trigger.event.data.entity_id or 'unknown' }}"
          entity_id: "{{ trigger.event.data.entity_id or '' }}"
          payload:
            entity_id: "{{ trigger.event.data.entity_id or '' }}"
            name: "{{ trigger.event.data.name or '' }}"
            source: "automation_triggered"

  - alias: "Mantis - unexpected device online"
    mode: single
    triggers:
      - trigger: state
        entity_id: binary_sensor.garage_camera_online
        to: "on"
    conditions:
      - condition: time
        after: "23:00:00"
        before: "06:00:00"
    actions:
      - action: rest_command.mantis_iot_event
        data:
          event: "unexpected-online"
          device: "garage-camera"
          entity_id: "{{ trigger.entity_id }}"
          area: "{{ area_name(trigger.entity_id) or '' }}"
          automation: "Mantis - unexpected device online"

  - alias: "Mantis - person at front door"
    mode: single
    triggers:
      - trigger: state
        entity_id: binary_sensor.front_door_person
        to: "on"
    actions:
      - action: rest_command.mantis_iot_event
        data:
          event: "person-detected"
          device: "{{ state_attr(trigger.entity_id, 'friendly_name') or trigger.entity_id }}"
          entity_id: "{{ trigger.entity_id }}"
          area: "{{ area_name(trigger.entity_id) or '' }}"
          automation: "Mantis - person at front door"
`;
  return {
    type: "homeassistant",
    name: INSTALLER_META.homeassistant.name,
    description: INSTALLER_META.homeassistant.description,
    os: "iot",
    filename: "mantis-homeassistant.yaml",
    mime: "text/yaml; charset=utf-8",
    content,
    install: [
      "# 1. Copy the rest_command block into configuration.yaml.",
      "# 2. Copy/adapt the automation examples into automations.yaml or the YAML editor.",
      "# 3. Reload YAML or restart Home Assistant.",
      "# 4. Trigger the sensor/automation and check mantis hits.",
    ],
    uninstall: [
      "# Remove rest_command.mantis_iot_event and the automations you added.",
      "# Reload YAML or restart Home Assistant.",
    ],
    notes:
      "Works with any Home Assistant entity: contact sensors, locks, alarm panels, device_tracker, Scrypted smart motion sensors, and bridged HomeKit devices. Use your private HA network to call the public mantis trigger URL. The \"automation triggered\" example skips every automation whose name starts with \"Mantis\" (itself, the other examples and the Mantis receiver), so its own requests cannot re-trigger it — keep that prefix if you rename them.",
  };
}

function buildScrypted({ url, memo }: InstallerInput): Installer {
  const content = `/**
 * Mantis Scrypted bridge — ${memo}
 *
 * Install: Scrypted Management Console -> Scripts -> Add New -> Empty Script.
 * Paste this file, edit WATCH, Save, then Run.
 *
 * This script listens to selected Scrypted devices/interfaces and POSTs to the
 * mantis URL with structured X-Mantis-* headers.
 *
 * Useful sources:
 *   - Smart Motion Sensor person/package/vehicle detections
 *   - MotionSensor devices
 *   - BinarySensor devices linked to doors/locks
 */

const MANTIS_URL = ${JSON.stringify(url)};

// Edit these entries. deviceId is visible in the Scrypted device URL/details.
// Common interfaces: "MotionSensor", "BinarySensor", "ObjectDetector", "OnOff".
const WATCH = [
  {
    deviceId: "front-door-camera-smart-motion",
    eventInterface: "MotionSensor",
    event: "person-detected",
    device: "front-door-camera",
    area: "front door",
  },
];

async function fireMantis(item, eventData) {
  const body = {
    event: item.event,
    device: item.device,
    area: item.area,
    deviceId: item.deviceId,
    interface: item.eventInterface,
    data: eventData ?? null,
    at: new Date().toISOString(),
  };

  const res = await fetch(MANTIS_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Mantis-Source": "scrypted",
      "X-Mantis-Event": item.event || "scrypted-event",
      "X-Mantis-Device": item.device || item.deviceId,
      "X-Mantis-Entity-Id": item.deviceId,
      "X-Mantis-Area": item.area || "",
    },
    body: JSON.stringify(body),
  });
  // fetch only rejects on network errors; an HTTP error (e.g. a 503 while
  // mantis is restarting) means nothing was recorded.
  if (!res.ok) throw new Error("HTTP " + res.status);
}

for (const item of WATCH) {
  const device = systemManager.getDeviceById(item.deviceId);
  if (!device) {
    console.warn("Mantis: device not found", item.deviceId);
    continue;
  }

  device.listen(
    { event: item.eventInterface, watch: true, denoise: true },
    async (_eventSource, _eventDetails, eventData) => {
      // Most binary/motion interfaces send truthy data for active/open/motion.
      if (eventData === false || eventData === "false" || eventData === "off") return;
      try {
        await fireMantis(item, eventData);
        console.log("Mantis fired", item.event, item.device || item.deviceId);
      } catch (e) {
        console.warn("Mantis fire failed", e);
      }
    },
  );

  console.log("Mantis watching", item.deviceId, item.eventInterface);
}
`;
  return {
    type: "scrypted",
    name: INSTALLER_META.scrypted.name,
    description: INSTALLER_META.scrypted.description,
    os: "iot",
    filename: "mantis-scrypted.js",
    mime: "application/javascript; charset=utf-8",
    content,
    install: [
      "Open Scrypted Management Console -> Scripts -> Add New -> Empty Script.",
      "Paste mantis-scrypted.js.",
      "Edit WATCH with your device id(s), event interface(s), and labels.",
      "Save, then Run. Check the script log for 'Mantis watching ...'.",
    ],
    uninstall: [
      "Stop/delete the Scrypted script, or remove entries from WATCH and Save.",
    ],
    notes:
      "If your Scrypted Smart Motion Sensor is already synced to Home Assistant, the Home Assistant installer is usually easier. This direct script is useful when you want Scrypted to fire mantis without HA in the middle.",
  };
}

function appendSrc(url: string, src: string): string {
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}src=${encodeURIComponent(src)}`;
}

/**
 * A Home Assistant webhook id is a URL path segment and lands inside a quoted
 * YAML scalar, so only URL-unreserved characters are accepted.
 */
export function isHomeAssistantWebhookId(s: string): boolean {
  return /^[A-Za-z0-9._~-]{1,128}$/.test(s);
}

/**
 * The webhook id is the only thing that authenticates Mantis to Home
 * Assistant, so it has to be unguessable and independent of the key: the key
 * UUID (and its 8-character prefix) is handed to enroll keys and webhook
 * receivers and is written into file and task names on monitored hosts.
 * 256 random bits, like Home Assistant's own generated ids. Web Crypto is
 * global in Node, browsers and Workers, which keeps this module import-free.
 */
function randomWebhookId(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(32));
  return (
    "mantis-" +
    Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
  );
}

function buildHomeAssistantReceiver(input: InstallerInput): Installer {
  const { keyId, memo } = input;
  const short = shortId(keyId);
  if (
    input.webhookId !== undefined &&
    !isHomeAssistantWebhookId(input.webhookId)
  ) {
    throw new Error(
      "webhookId must be 1-128 characters from A-Z a-z 0-9 . _ ~ -",
    );
  }
  // One id per call, used for both the automation and the registration
  // command, so the two always agree.
  const webhookId = input.webhookId ?? randomWebhookId();
  // A caller that supplies the id (the Mantis server derives one per key)
  // renders the same file every time; without one each render differs.
  const idOrigin =
    input.webhookId !== undefined
      ? {
          comment: [
            "The webhook_id below is this key's own. Treat it like a secret: it",
            "is the only credential between Mantis and HA.",
          ],
          note: "The webhook_id is unguessable and is the only credential between Mantis and HA; treat it like a secret.",
        }
      : {
          comment: [
            "The webhook_id below was generated at random for this file. Treat it",
            "like a secret: it is the only credential between Mantis and HA. A new",
            "one is generated every time this installer is rendered, so take the",
            "YAML and the command in step 3 from the same render.",
          ],
          note: "The webhook_id is random and is the only credential between Mantis and HA; a new one is generated on every render, so use the YAML and the `mantis dest add` command from the same render.",
        };
  const content = `# Mantis Home Assistant receiver — ${memo}
#
# This automation listens for Mantis hits delivered via the
# home_assistant notification channel and runs your chosen action —
# flip a switch, run a script, send a phone notification, etc.
#
# Setup:
#   1. ${idOrigin.comment.join("\n#      ")}
#   2. Paste this YAML into automations.yaml or the HA YAML editor and
#      reload automations.
#   3. Register the destination in Mantis:
#        mantis dest add ${short} home_assistant \\
#          https://<your-ha-host>/api/webhook/${webhookId}
#      Mantis fires an activation ping immediately on create. It triggers
#      this automation but stops at the condition below (type
#      "mantis.activation"), so look for it in the automation's traces: no
#      action runs.
#
# Tailscale note: if Mantis reaches HA over the tailnet (100.64.0.0/10
# CGNAT range) the SSRF guard refuses the private address and the activation
# ping fails with "destination refused: it does not resolve to a public
# address". Every refused destination gets that same message; the Mantis
# server log records the actual reason.
# WARNING: ALLOW_PRIVATE_WEBHOOKS=1 lifts that block, but it is a GLOBAL switch
# — it disables SSRF protection for EVERY destination and channel instance-wide,
# not just this HA webhook. Prefer restricting egress to the HA host at the
# network layer over enabling it for the whole instance.

automation:
  - alias: ${JSON.stringify(`Mantis hit — ${memo}`)}
    mode: queued        # serialize rapid hits
    max: 10
    triggers:
      - trigger: webhook
        webhook_id: "${webhookId}"
        allowed_methods:
          - POST
        local_only: false  # set true to reject WAN-sourced requests
    conditions:
      # Activation ping — the first-time test payload stops here, before any
      # action runs.
      - condition: template
        value_template: "{{ trigger.json.type != 'mantis.activation' }}"
    actions:
      # Example A: cut internet on a VLAN via the OPNsense integration.
      - action: switch.turn_off
        target:
          entity_id: switch.opnsense_vlan_iot_internet

      # Example B: phone notification with full hit context.
      - action: notify.mobile_app_iphone
        data:
          title: "Mantis: {{ trigger.json.memo }}"
          message: >-
            Hit from {{ trigger.json.ip }} at {{ trigger.json.occurred_at }}
            ({{ trigger.json.host_context.user | default('') }}@{{ trigger.json.host_context.host | default('') }})
            SSH: {{ trigger.json.host_context.ssh_client_ip | default('-') }}

      # Example C: logbook entry for audit.
      - action: logbook.log
        data:
          name: Mantis
          message: >-
            Triggered {{ trigger.json.memo }} from
            {{ trigger.json.host_context.ssh_client_ip | default(trigger.json.ip) }}
`;
  return {
    type: "homeassistant-receiver",
    name: INSTALLER_META["homeassistant-receiver"].name,
    description: INSTALLER_META["homeassistant-receiver"].description,
    os: "iot",
    filename: "mantis-homeassistant-receiver.yaml",
    mime: "text/yaml; charset=utf-8",
    content,
    install: [
      "# 1. Paste this YAML into automations.yaml (or the HA UI YAML editor).",
      "# 2. Reload automations or restart Home Assistant.",
      `# 3. Register the Mantis destination:`,
      `#      mantis dest add ${short} home_assistant https://<your-ha-host>/api/webhook/${webhookId}`,
      "# 4. The activation ping triggers this automation once on create and stops",
      "#    at its condition (see the automation's traces); no action runs.",
      "# 5. Trigger the mantis URL — the hit payload runs your action chain.",
    ],
    uninstall: [
      "# Remove the automation entry above (and unregister the Mantis destination).",
      "# Reload automations or restart Home Assistant.",
    ],
    notes:
      idOrigin.note +
      " If Mantis reaches HA over Tailscale (100.64.0.0/10) or any RFC1918 network, the SSRF guard blocks the private address. ALLOW_PRIVATE_WEBHOOKS=1 lifts it, but it is GLOBAL — it disables SSRF protection for every destination and channel instance-wide, so prefer restricting egress to the HA host at the network layer. The activation ping surfaces unreachable-URL errors immediately via `mantis dest add`; every refused destination reports \"destination refused: it does not resolve to a public address\", and the Mantis server log has the reason.",
    webhookId,
  };
}

const BUILDERS: Record<InstallType, (input: InstallerInput) => Installer> = {
  shell: buildShell,
  "shell-sudo": buildShellSudo,
  "macos-login": buildMacosLogin,
  "macos-boot": buildMacosBoot,
  "macos-wake": buildMacosWake,
  "macos-network": buildMacosNetwork,
  "linux-boot": buildLinuxBoot,
  "linux-wake": buildLinuxWake,
  "linux-network": buildLinuxNetwork,
  "windows-logon": buildWindowsLogon,
  "windows-wake": buildWindowsWake,
  "windows-network": buildWindowsNetwork,
  "css-background": buildCssBackground,
  "js-clone-detector": buildJsCloneDetector,
  "nfc-ndef": buildNfcNdef,
  homeassistant: buildHomeAssistant,
  "homeassistant-receiver": buildHomeAssistantReceiver,
  scrypted: buildScrypted,
};

/**
 * Memo and hostname are operator text that gets interpolated into generated
 * code comments and YAML. Neutralise anything that could end the enclosing
 * comment or line — a memo containing a star-slash sequence would otherwise
 * become live JavaScript/CSS wherever the snippet is pasted, and a newline
 * breaks out of a `#` comment. Values that sit inside quoted strings are
 * additionally quoted at the use site (JSON.stringify).
 *
 * "Newline" is whatever the consumer of the generated file says it is: YAML
 * 1.1 loaders (PyYAML, libyaml — Home Assistant) also end a line at NEL
 * (U+0085), LS (U+2028) and PS (U+2029), so the C1 controls and both Unicode
 * separators are collapsed along with the ASCII ones.
 */
export function templateSafeText(s: string): string {
  return s
    .replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]+/g, " ")
    .replace(/\*\//g, "* /")
    .replace(/<\//g, "< /")
    .trim();
}

export function buildInstaller(
  type: InstallType,
  input: InstallerInput,
): Installer {
  const safe: InstallerInput = {
    ...input,
    memo: templateSafeText(input.memo),
    ...(input.hostname !== undefined
      ? { hostname: templateSafeText(input.hostname) }
      : {}),
  };
  return BUILDERS[type](safe);
}

export function isInstallType(s: string): s is InstallType {
  return (ALL_INSTALL_TYPES as string[]).includes(s);
}

/**
 * Wrap the `(curl … ) &) 2>/dev/null` block of a shell / shell-sudo snippet
 * in `if [[ -n "$SSH_CONNECTION" ]]; then ... fi` so the canary only fires
 * for SSH-originated shell sessions, not every local tmux pane. Returns the
 * snippet unchanged when no `(curl ` line is found (caller's responsibility
 * to only apply this to shell-family installers).
 */
export function applySshOnlyGuard(snippet: string): string {
  const lines = snippet.split("\n");
  const start = lines.findIndex((l) => l.trim().startsWith("(curl "));
  if (start < 0) return snippet;
  const end = lines.findIndex(
    (l, i) => i >= start && l.includes(") 2>/dev/null"),
  );
  if (end < 0) return snippet;
  const head = lines.slice(0, start);
  const block = lines.slice(start, end + 1).map((l) => "  " + l);
  const tail = lines.slice(end + 1);
  return [
    ...head,
    "# SSH-only guard added by --ssh-only.",
    'if [[ -n "$SSH_CONNECTION" ]]; then',
    ...block,
    "fi",
    ...tail,
  ].join("\n");
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
