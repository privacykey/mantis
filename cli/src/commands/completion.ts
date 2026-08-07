import { ALL_INSTALL_TYPES } from "@mantis/core/installers";
import { ALL_CHANNELS } from "../lib/channels.js";

// Shell completion scripts for bash, zsh, fish.
//
// Keep this file in sync with the command tree wired up in `src/index.ts`.
// Aliases are listed alongside their canonical names so completion suggests
// both forms.

const COMMANDS = [
  "init",
  "login",
  "logout",
  "backup",
  "restore",
  "whoami",
  "doctor",
  "detect",
  "profile",
  "cloudflare",
  "edge",
  "device",
  "new",
  "bulk-create",
  "import-csv",
  "download",
  "monitor",
  "reset",
  "status",
  "last",
  "open",
  "install",
  "list",
  "ls",
  "show",
  "rm",
  "delete",
  "disable",
  "enable",
  "destinations",
  "dest",
  "audit",
  "hits",
  "watch",
  "completion",
  "config",
  "plugin",
];

const PROFILE_SUBS = [
  "list",
  "ls",
  "current",
  "use",
  "show",
  "rm",
  "delete",
  "set-edge",
];
const CLOUDFLARE_SUBS = ["login", "logout", "set-service-auth", "status"];
const EDGE_SUBS = [
  "keygen",
  "set-key",
  "delete-key",
  "mint",
  "install",
  "device",
];
const DEVICE_SUBS = ["profiles", "new"];
const DEST_SUBS = ["list", "ls", "add", "rm", "remove", "test", "rotate-secret"];
const AUDIT_SUBS = ["log"];
const PLUGIN_SUBS = ["add", "list", "ls", "remove", "rm", "upgrade"];

const SHELLS = ["bash", "zsh", "fish"];

// Derived from the canonical list rather than copied: the hand-maintained
// version had drifted, missing homeassistant, homeassistant-receiver and
// scrypted, so those types never tab-completed.
const INSTALL_TYPES: readonly string[] = ALL_INSTALL_TYPES;

const RESPONSE_KINDS = ["gif", "empty", "json", "redirect", "html"];
const CHANNELS: readonly string[] = ALL_CHANNELS;
const MONITOR_MODES = ["off", "latch", "window"];
const SCOPES = ["user", "system", "all"];
const OUTPUT_MODES = ["table", "json", "wide"];

export function completionCmd(shell: string): void {
  switch (shell) {
    case "bash":
      process.stdout.write(bashCompletion());
      return;
    case "zsh":
      process.stdout.write(zshCompletion());
      return;
    case "fish":
      process.stdout.write(fishCompletion());
      return;
    default:
      throw new Error("shell must be one of: bash, zsh, fish");
  }
}

function bashCompletion(): string {
  return `# mantis bash completion
_mantis_completion() {
  local cur prev
  COMPREPLY=()
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"

  # Option-value completions take precedence over positional ones.
  case "$prev" in
    --response-kind|-r) COMPREPLY=( $(compgen -W "${RESPONSE_KINDS.join(" ")}" -- "$cur") ); return ;;
    --channel)          COMPREPLY=( $(compgen -W "${CHANNELS.join(" ")}" -- "$cur") ); return ;;
    --type|-t|--install) COMPREPLY=( $(compgen -W "${INSTALL_TYPES.join(" ")}" -- "$cur") ); return ;;
    --mode|-m)          COMPREPLY=( $(compgen -W "${MONITOR_MODES.join(" ")}" -- "$cur") ); return ;;
    --scope)            COMPREPLY=( $(compgen -W "${SCOPES.join(" ")}" -- "$cur") ); return ;;
    --output)           COMPREPLY=( $(compgen -W "${OUTPUT_MODES.join(" ")}" -- "$cur") ); return ;;
  esac

  # First positional → top-level command.
  if [[ $COMP_CWORD -eq 1 ]]; then
    COMPREPLY=( $(compgen -W "${COMMANDS.join(" ")}" -- "$cur") )
    return
  fi

  # Second positional → subcommand (when the first selected one has them).
  if [[ $COMP_CWORD -eq 2 ]]; then
    case "\${COMP_WORDS[1]}" in
      profile)            COMPREPLY=( $(compgen -W "${PROFILE_SUBS.join(" ")}" -- "$cur") ); return ;;
      cloudflare)         COMPREPLY=( $(compgen -W "${CLOUDFLARE_SUBS.join(" ")}" -- "$cur") ); return ;;
      edge)               COMPREPLY=( $(compgen -W "${EDGE_SUBS.join(" ")}" -- "$cur") ); return ;;
      device)             COMPREPLY=( $(compgen -W "${DEVICE_SUBS.join(" ")}" -- "$cur") ); return ;;
      destinations|dest)  COMPREPLY=( $(compgen -W "${DEST_SUBS.join(" ")}" -- "$cur") ); return ;;
      audit)              COMPREPLY=( $(compgen -W "${AUDIT_SUBS.join(" ")}" -- "$cur") ); return ;;
      plugin)             COMPREPLY=( $(compgen -W "${PLUGIN_SUBS.join(" ")}" -- "$cur") ); return ;;
      completion)         COMPREPLY=( $(compgen -W "${SHELLS.join(" ")}" -- "$cur") ); return ;;
    esac
  fi
}
complete -F _mantis_completion mantis
`;
}

function zshCompletion(): string {
  return `#compdef mantis
_mantis() {
  local -a commands profile_subs cloudflare_subs edge_subs device_subs dest_subs audit_subs plugin_subs
  local -a response_kinds channels install_types monitor_modes scopes output_modes shells
  commands=(${COMMANDS.join(" ")})
  profile_subs=(${PROFILE_SUBS.join(" ")})
  cloudflare_subs=(${CLOUDFLARE_SUBS.join(" ")})
  edge_subs=(${EDGE_SUBS.join(" ")})
  device_subs=(${DEVICE_SUBS.join(" ")})
  dest_subs=(${DEST_SUBS.join(" ")})
  audit_subs=(${AUDIT_SUBS.join(" ")})
  plugin_subs=(${PLUGIN_SUBS.join(" ")})
  response_kinds=(${RESPONSE_KINDS.join(" ")})
  channels=(${CHANNELS.join(" ")})
  install_types=(${INSTALL_TYPES.join(" ")})
  monitor_modes=(${MONITOR_MODES.join(" ")})
  scopes=(${SCOPES.join(" ")})
  output_modes=(${OUTPUT_MODES.join(" ")})
  shells=(${SHELLS.join(" ")})

  # Option-value completions take precedence over positional ones.
  case "$words[CURRENT-1]" in
    --response-kind|-r) _describe 'response kind' response_kinds; return ;;
    --channel)          _describe 'channel' channels; return ;;
    --type|-t|--install) _describe 'installer type' install_types; return ;;
    --mode|-m)          _describe 'monitor mode' monitor_modes; return ;;
    --scope)            _describe 'scope' scopes; return ;;
    --output)           _describe 'output mode' output_modes; return ;;
  esac

  # First positional → top-level command.
  if (( CURRENT == 2 )); then
    _describe 'command' commands
    return
  fi

  # Second positional → subcommand (when the first one has them).
  if (( CURRENT == 3 )); then
    case "$words[2]" in
      profile)            _describe 'profile subcommand' profile_subs; return ;;
      cloudflare)         _describe 'cloudflare subcommand' cloudflare_subs; return ;;
      edge)               _describe 'edge subcommand' edge_subs; return ;;
      device)             _describe 'device subcommand' device_subs; return ;;
      destinations|dest)  _describe 'destinations subcommand' dest_subs; return ;;
      audit)              _describe 'audit subcommand' audit_subs; return ;;
      plugin)             _describe 'plugin subcommand' plugin_subs; return ;;
      completion)         _describe 'shell' shells; return ;;
    esac
  fi

  _files
}
_mantis "$@"
`;
}

function fishCompletion(): string {
  const subcommandLines = (
    parent: string,
    subs: readonly string[],
  ): string[] =>
    subs.map(
      (sub) =>
        `complete -c mantis -n '__fish_seen_subcommand_from ${parent}' -a ${sub}`,
    );

  const lines = [
    "complete -c mantis -f",
    // Top-level commands (only when no subcommand has been picked yet).
    ...COMMANDS.map(
      (cmd) => `complete -c mantis -n '__fish_use_subcommand' -a ${cmd}`,
    ),
    // Nested subcommands.
    ...subcommandLines("profile", PROFILE_SUBS),
    ...subcommandLines("cloudflare", CLOUDFLARE_SUBS),
    ...subcommandLines("edge", EDGE_SUBS),
    ...subcommandLines("device", DEVICE_SUBS),
    ...subcommandLines("destinations", DEST_SUBS),
    ...subcommandLines("dest", DEST_SUBS),
    ...subcommandLines("audit", AUDIT_SUBS),
    ...subcommandLines("plugin", PLUGIN_SUBS),
    ...subcommandLines("completion", SHELLS),
    // Option-value completions (fish handles -a as a space-separated list).
    `complete -c mantis -l response-kind -s r -a '${RESPONSE_KINDS.join(" ")}'`,
    `complete -c mantis -l channel -a '${CHANNELS.join(" ")}'`,
    `complete -c mantis -l type -s t -a '${INSTALL_TYPES.join(" ")}'`,
    `complete -c mantis -l install -a '${INSTALL_TYPES.join(" ")}'`,
    `complete -c mantis -l mode -s m -a '${MONITOR_MODES.join(" ")}'`,
    `complete -c mantis -l scope -a '${SCOPES.join(" ")}'`,
    `complete -c mantis -l output -a '${OUTPUT_MODES.join(" ")}'`,
  ];
  return lines.join("\n") + "\n";
}
