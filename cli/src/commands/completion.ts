const COMMANDS = [
  "login",
  "logout",
  "whoami",
  "profile",
  "cloudflare",
  "edge",
  "new",
  "download",
  "monitor",
  "reset",
  "status",
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
  "hits",
  "watch",
  "completion",
];

const INSTALL_TYPES = [
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
];

const RESPONSE_KINDS = ["gif", "empty", "json", "redirect", "html"];
const CHANNELS = ["webhook", "email", "slack", "discord", "teams"];

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
  local cur prev words
  COMPREPLY=()
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"

  case "$prev" in
    --response-kind|-r) COMPREPLY=( $(compgen -W "${RESPONSE_KINDS.join(" ")}" -- "$cur") ); return ;;
    --channel) COMPREPLY=( $(compgen -W "${CHANNELS.join(" ")}" -- "$cur") ); return ;;
    --type|-t) COMPREPLY=( $(compgen -W "${INSTALL_TYPES.join(" ")}" -- "$cur") ); return ;;
    --mode|-m) COMPREPLY=( $(compgen -W "off latch window" -- "$cur") ); return ;;
  esac

  if [[ $COMP_CWORD -eq 1 ]]; then
    COMPREPLY=( $(compgen -W "${COMMANDS.join(" ")}" -- "$cur") )
  fi
}
complete -F _mantis_completion mantis
`;
}

function zshCompletion(): string {
  return `#compdef mantis
_mantis() {
  local -a commands response_kinds channels install_types
  commands=(${COMMANDS.join(" ")})
  response_kinds=(${RESPONSE_KINDS.join(" ")})
  channels=(${CHANNELS.join(" ")})
  install_types=(${INSTALL_TYPES.join(" ")})

  case "$words[CURRENT-1]" in
    --response-kind|-r) _describe 'response kind' response_kinds; return ;;
    --channel) _describe 'channel' channels; return ;;
    --type|-t) _describe 'installer type' install_types; return ;;
    --mode|-m) _values 'mode' off latch window; return ;;
  esac

  if (( CURRENT == 2 )); then
    _describe 'command' commands
  else
    _files
  fi
}
_mantis "$@"
`;
}

function fishCompletion(): string {
  const lines = [
    "complete -c mantis -f",
    ...COMMANDS.map((cmd) => `complete -c mantis -n '__fish_use_subcommand' -a ${cmd}`),
    ...RESPONSE_KINDS.map(
      (kind) => `complete -c mantis -l response-kind -s r -a ${kind}`,
    ),
    ...CHANNELS.map((channel) => `complete -c mantis -l channel -a ${channel}`),
    ...INSTALL_TYPES.map((type) => `complete -c mantis -l type -s t -a ${type}`),
  ];
  return lines.join("\n") + "\n";
}
