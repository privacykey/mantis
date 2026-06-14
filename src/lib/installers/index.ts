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
};

export type InstallerInput = {
  url: string;
  keyId: string;
  memo: string;
  /** Required for js-clone-detector; ignored elsewhere. */
  hostname?: string;
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
      "CSS snippet that loads a 1×1 background image from the mantis URL. When someone copies your CSS to another site, the URL loads and fires the canary. Distinguish your own site from a clone by the Referer header on the captured hit.",
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

function buildShell({ url }: InstallerInput): Installer {
  const content = `# mantis: fires on shell startup (covers ssh logins)
# Generated by mantis — paste into ~/.bashrc, ~/.zshrc, or ~/.bash_profile.
(curl -fsS -m 3 -o /dev/null \\
  -H "X-Mantis-Source: shell" \\
  -H "X-Mantis-User: \${USER:-unknown}" \\
  -H "X-Mantis-Host: $(hostname 2>/dev/null || echo unknown)" \\
  -H "X-Mantis-SSH-Client: \${SSH_CLIENT:-}" \\
  -H "X-Mantis-SSH-Connection: \${SSH_CONNECTION:-}" \\
  -H "X-Mantis-TTY: $(tty 2>/dev/null || echo)" \\
  "${url}" >/dev/null 2>&1 &) 2>/dev/null
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
  const shCmd = `/usr/bin/curl -fsS -m 10 -o /dev/null \
-H "X-Mantis-Source: macos-boot" \
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
      "Boots before any user logs in (no $USER yet). 10s curl timeout absorbs the network-coming-up gap. Captures hostname only.",
  };
}

function buildLinuxBoot(input: InstallerInput): Installer {
  const unitName = `mantis-${shortId(input.keyId)}.service`;
  // systemd ExecStart with sh -c so we can interpolate $(hostname).
  // Single quote the whole sh -c arg; use double quotes inside for header values.
  const content = `[Unit]
Description=Mantis boot ping for key ${input.keyId}
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/bin/sh -c '/usr/bin/curl -fsS -m 10 -o /dev/null -H "X-Mantis-Source: linux-boot" -H "X-Mantis-Host: $(hostname)" "${input.url}"'

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
    install: [
      `sudo mv ${unitName} /etc/systemd/system/`,
      `sudo systemctl daemon-reload`,
      `sudo systemctl enable ${unitName}`,
    ],
    uninstall: [
      `sudo systemctl disable ${unitName}`,
      `sudo rm /etc/systemd/system/${unitName}`,
      `sudo systemctl daemon-reload`,
    ],
    notes: "Captures hostname (no $USER at boot time).",
  };
}

function buildWindowsLogon(input: InstallerInput): Installer {
  const id = shortId(input.keyId);
  const psUrl = input.url.replace(/'/g, "''");
  // PowerShell hashtable for headers; @{key='val';...} syntax.
  const psCommand = `try { $h = @{'X-Mantis-Source'='windows-logon'; 'X-Mantis-User'=$env:USERNAME; 'X-Mantis-Host'=$env:COMPUTERNAME}; Invoke-WebRequest -Uri '${psUrl}' -Headers $h -UseBasicParsing -TimeoutSec 5 | Out-Null } catch {}`;
  const content = `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Author>mantis</Author>
    <Description>Mantis logon ping (${id})</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <ExecutionTimeLimit>PT30S</ExecutionTimeLimit>
    <AllowStartIfOnBatteries>true</AllowStartIfOnBatteries>
    <DontStopIfGoingOnBatteries>true</DontStopIfGoingOnBatteries>
    <Hidden>true</Hidden>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>powershell.exe</Command>
      <Arguments>-WindowStyle Hidden -NoProfile -Command "${escapeXml(psCommand)}"</Arguments>
    </Exec>
  </Actions>
</Task>
`;
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
    notes: "Captures $env:USERNAME and $env:COMPUTERNAME.",
  };
}

function buildShellSudo({ url }: InstallerInput): Installer {
  const content = `# mantis: fires when 'sudo' is invoked from a shell that sourced this file.
# Generated by mantis — paste into ~/.bashrc / ~/.zshrc.
sudo() {
  (curl -fsS -m 3 -o /dev/null \\
    -H "X-Mantis-Source: shell-sudo" \\
    -H "X-Mantis-User: \${USER:-unknown}" \\
    -H "X-Mantis-Host: $(hostname 2>/dev/null || echo unknown)" \\
    -H "X-Mantis-SSH-Client: \${SSH_CLIENT:-}" \\
    -H "X-Mantis-Sudo-Cmd: $*" \\
    "${url}" >/dev/null 2>&1 &) 2>/dev/null
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
      "Only fires when sudo is called from a shell that sourced this snippet. Sudo invoked by daemons or GUI tools is not captured. Sends X-Mantis-Sudo-Cmd with the original sudo arguments.",
  };
}

function buildMacosWake({ url }: InstallerInput): Installer {
  const content = `#!/bin/sh
# mantis: ~/.wakeup hook for sleepwatcher
# Fires when the Mac wakes from sleep.
/usr/bin/curl -fsS -m 5 -o /dev/null \\
  -H "X-Mantis-Source: macos-wake" \\
  -H "X-Mantis-User: $USER" \\
  -H "X-Mantis-Host: $(hostname)" \\
  "${url}"
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
      "Requires sleepwatcher (Homebrew). macOS has no built-in user-space wake hook; sleepwatcher fills that gap with ~/.sleep and ~/.wakeup scripts.",
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
  const content = `[Unit]
Description=Mantis wake ping for key ${input.keyId}
After=suspend.target hibernate.target hybrid-sleep.target

[Service]
Type=oneshot
ExecStart=/bin/sh -c '/usr/bin/curl -fsS -m 10 -o /dev/null -H "X-Mantis-Source: linux-wake" -H "X-Mantis-Host: $(hostname)" "${input.url}"'

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
    install: [
      `sudo mv ${unitName} /etc/systemd/system/`,
      `sudo systemctl daemon-reload`,
      `sudo systemctl enable ${unitName}`,
    ],
    uninstall: [
      `sudo systemctl disable ${unitName}`,
      `sudo rm /etc/systemd/system/${unitName}`,
      `sudo systemctl daemon-reload`,
    ],
    notes:
      "WantedBy the sleep targets means systemd starts this unit when the system *resumes* from those states.",
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
  const psCommand = `try { $h = @{'X-Mantis-Source'='windows-wake'; 'X-Mantis-User'=$env:USERNAME; 'X-Mantis-Host'=$env:COMPUTERNAME}; Invoke-WebRequest -Uri '${psUrl}' -Headers $h -UseBasicParsing -TimeoutSec 5 | Out-Null } catch {}`;
  const content = `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Author>mantis</Author>
    <Description>Mantis wake ping (${id})</Description>
  </RegistrationInfo>
  <Triggers>
    <EventTrigger>
      <Enabled>true</Enabled>
      <Subscription>${escapeXml(`<QueryList><Query Id="0" Path="System"><Select Path="System">*[System[Provider[@Name='Microsoft-Windows-Power-Troubleshooter'] and (EventID=1)]]</Select></Query></QueryList>`)}</Subscription>
    </EventTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <ExecutionTimeLimit>PT30S</ExecutionTimeLimit>
    <AllowStartIfOnBatteries>true</AllowStartIfOnBatteries>
    <DontStopIfGoingOnBatteries>true</DontStopIfGoingOnBatteries>
    <Hidden>true</Hidden>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>powershell.exe</Command>
      <Arguments>-WindowStyle Hidden -NoProfile -Command "${escapeXml(psCommand)}"</Arguments>
    </Exec>
  </Actions>
</Task>
`;
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
      "Triggers on System log event 1 from Microsoft-Windows-Power-Troubleshooter, which fires whenever the system resumes from sleep/hibernate.",
  };
}

function buildWindowsNetwork(input: InstallerInput): Installer {
  const id = shortId(input.keyId);
  const psUrl = input.url.replace(/'/g, "''");
  const psCommand = `try { $h = @{'X-Mantis-Source'='windows-network'; 'X-Mantis-User'=$env:USERNAME; 'X-Mantis-Host'=$env:COMPUTERNAME}; Invoke-WebRequest -Uri '${psUrl}' -Headers $h -UseBasicParsing -TimeoutSec 5 | Out-Null } catch {}`;
  const content = `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Author>mantis</Author>
    <Description>Mantis network-attach ping (${id})</Description>
  </RegistrationInfo>
  <Triggers>
    <EventTrigger>
      <Enabled>true</Enabled>
      <Subscription>${escapeXml(`<QueryList><Query Id="0" Path="Microsoft-Windows-NetworkProfile/Operational"><Select Path="Microsoft-Windows-NetworkProfile/Operational">*[System[(EventID=10000)]]</Select></Query></QueryList>`)}</Subscription>
    </EventTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <ExecutionTimeLimit>PT30S</ExecutionTimeLimit>
    <AllowStartIfOnBatteries>true</AllowStartIfOnBatteries>
    <DontStopIfGoingOnBatteries>true</DontStopIfGoingOnBatteries>
    <Hidden>true</Hidden>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>powershell.exe</Command>
      <Arguments>-WindowStyle Hidden -NoProfile -Command "${escapeXml(psCommand)}"</Arguments>
    </Exec>
  </Actions>
</Task>
`;
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
      "Triggers on Microsoft-Windows-NetworkProfile/Operational event 10000, which fires when a network profile is connected (Wi-Fi join, Ethernet plug-in, VPN up).",
  };
}

function buildCssBackground({ url, memo }: InstallerInput): Installer {
  // Use CSS string-escape sequences on the hostname to obscure casual reading
  // (the way canarytokens.org does). The escapes are equivalent — browsers
  // parse them the same as plain ASCII — but they make the URL less obvious
  // when someone glances at the stylesheet.
  const obfuscated = url.replace(/[a-z]/g, (ch) => {
    // Only escape lowercase letters in the hostname part, leave the path
    // alone so it stays a valid URL after CSS parsing. Keep this rough —
    // the goal is "harder to read", not "impossible to read".
    return Math.random() < 0.35
      ? "\\" + ch.charCodeAt(0).toString(16)
      : ch;
  });
  const content = `/*
 * Mantis canary CSS — fires when the stylesheet is rendered.
 * Generated for: ${memo}
 *
 * Paste into your site's stylesheet (or a <style> block). When someone
 * copies your CSS to another site, the URL loads and fires the canary.
 * Both your site and the cloned site will fire hits — distinguish them
 * by the Referer header on each captured hit.
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
      "URL is partially obfuscated with CSS escape sequences (\\6c, \\72, etc.) — browsers parse it identically. The canary returns a 1×1 transparent GIF so the background is visually invisible. Filter notifications by Referer header to ignore hits from your own site.",
  };
}

function buildJsCloneDetector({ url, memo, hostname }: InstallerInput): Installer {
  const expected = hostname && hostname.trim().length > 0 ? hostname.trim() : "";
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
  var h = (window.location.hostname || "").toLowerCase();
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
    triggers:
      - trigger: event
        event_type: automation_triggered
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
      "Works with any Home Assistant entity: contact sensors, locks, alarm panels, device_tracker, Scrypted smart motion sensors, and bridged HomeKit devices. Use your private HA network to call the public mantis trigger URL.",
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

  await fetch(MANTIS_URL, {
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

function buildHomeAssistantReceiver({ keyId, memo }: InstallerInput): Installer {
  const short = shortId(keyId);
  const webhookId = `mantis-${short}`;
  const content = `# Mantis Home Assistant receiver — ${memo}
#
# This automation listens for Mantis hits delivered via the
# home_assistant notification channel and runs your chosen action —
# flip a switch, run a script, send a phone notification, etc.
#
# Setup:
#   1. Pick a unique webhook_id below (treat it like a secret; it is the
#      only credential between Mantis and HA).
#   2. Paste this YAML into automations.yaml or the HA YAML editor and
#      reload automations.
#   3. Register the destination in Mantis:
#        mantis dest add ${short} home_assistant \\
#          https://<your-ha-host>/api/webhook/${webhookId}
#      Mantis fires an activation ping immediately on create, so you
#      should see this automation run once with type "mantis.activation".
#
# Tailscale note: if Mantis reaches HA over the tailnet (100.64.0.0/10
# CGNAT range) the SSRF guard refuses the private address and the activation
# ping fails with "resolves to a private address".
# WARNING: ALLOW_PRIVATE_WEBHOOKS=1 lifts that block, but it is a GLOBAL switch
# — it disables SSRF protection for EVERY destination and channel instance-wide,
# not just this HA webhook. Prefer restricting egress to the HA host at the
# network layer over enabling it for the whole instance.

automation:
  - alias: "Mantis hit — ${memo}"
    mode: queued        # serialize rapid hits
    triggers:
      - trigger: webhook
        webhook_id: "${webhookId}"
        allowed_methods:
          - POST
        local_only: false  # set true to reject WAN-sourced requests
    actions:
      # Activation ping — quietly ignore the first-time test payload.
      - if:
          - condition: template
            value_template: "{{ trigger.json.type == 'mantis.activation' }}"
        then:
          - stop: "Mantis activation ping"

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
      "# 4. The activation ping should fire this automation once on create.",
      "# 5. Trigger the mantis URL — the hit payload runs your action chain.",
    ],
    uninstall: [
      "# Remove the automation entry above (and unregister the Mantis destination).",
      "# Reload automations or restart Home Assistant.",
    ],
    notes:
      "If Mantis reaches HA over Tailscale (100.64.0.0/10) or any RFC1918 network, the SSRF guard blocks the private address. ALLOW_PRIVATE_WEBHOOKS=1 lifts it, but it is GLOBAL — it disables SSRF protection for every destination and channel instance-wide, so prefer restricting egress to the HA host at the network layer. The activation ping surfaces unreachable-URL errors immediately via `mantis dest add`.",
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

export function buildInstaller(
  type: InstallType,
  input: InstallerInput,
): Installer {
  return BUILDERS[type](input);
}

export function isInstallType(s: string): s is InstallType {
  return (ALL_INSTALL_TYPES as string[]).includes(s);
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
