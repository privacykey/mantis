# @mantis/cli

Command-line client for [mantis](../README.md) — manage keys and watch hits from the terminal.

For a visual overview of every command and how they relate, see
[`COMMAND_MAP.md`](./COMMAND_MAP.md).

## Install (from this repo)

```bash
cd cli
npm install
npm run build
npm link            # exposes `mantis` on $PATH
```

For one-off use without linking: `node cli/dist/index.js <command>`.

## Quickstart

```bash
mantis login                                    # prompts for URL + key
mantis new                                      # bare: launches interactive wizard
mantis new "test on prod" -w https://example.com/hook --copy
mantis new "ssh on prod" --install shell --ssh-only --out ~/.zshrc.d/mantis.sh
mantis list
mantis hits <key-id>
mantis watch                                    # polls; prints new hits live
mantis doctor                                   # checks auth, health, and split hosts
```

The wizard (run `mantis new` bare on a TTY) walks you through memo → optional installer (shell / macos-login / css-background / …) → notification destinations (loop, with channel-aware webhook prompts and host-based channel inference) → expiry → copy, then shows a summary with per-field `edit` before creating the key. Scripts that pass `--notify`/`-w`/`-e` or a positional memo never see a prompt — the wizard only kicks in when stdin is interactive AND the memo is missing.

The same wizard shape works on `mantis edge mint` — both build on `src/lib/wizard.ts`.

Credentials are stored in:
- `~/.config/mantis/config.json` — base URL + key prefix (for display) + Cloudflare Access mode/app URL (non-sensitive)
- OS keychain (`mantis-cli` service, account = base URL) — full API key
- OS keychain (`mantis-cli-cf` service, account = base URL) — Cloudflare Access service-auth credentials (if configured)
- `~/.cloudflared/` — short-lived JWTs cached by the `cloudflared` binary itself (managed externally; we don't touch them)

## Commands

| Command | Purpose |
|---|---|
| `init` | Guided first-time setup: asks server or edge, then runs login / key setup and offers to create a first key |
| `login [--url URL] [--key-stdin] [--no-switch]` | Prompt + store API key in keychain (under `--profile <name>` if given); `--key-stdin` reads the key from stdin |
| `logout [--all]` | Remove stored credentials for the current profile (or all profiles) |
| `backup [-o <file>] [--only <name>]` | Export profiles + plugin manifest into a passphrase-encrypted JSON bundle (scrypt + AES-256-GCM). Safe to commit to a private git-crypt repo. |
| `restore <file> [--overwrite] [--skip-plugins]` | Decrypt a backup bundle and restore profiles into config + keychain. Re-installs plugins via `mantis plugin add <source>@<ref>`. |
| `whoami` | Show current profile: server, key prefix, Cloudflare state, linked edge worker |
| `doctor [--public-url URL]` | Check CLI config, server health, auth, Cloudflare, and split public/private hosts |
| `detect [--scope user\|system\|all] [--deep]` | Offline self-audit for Mantis-style installer artifacts on this machine |
| `profile list` / `ls` | List all stored profiles (current marked with `*`) |
| `profile current` | Print the active profile name |
| `profile use <name>` | Switch the active profile |
| `profile show [name]` | Show one profile's details (default: current) |
| `profile rm <name> --yes` | Remove a profile + its keychain entry |
| `profile set-edge <name> --worker <url>` / `--clear` | Link a default mantis-edge worker URL to a profile |
| `new [memo] [opts]` | Create a key. Omit `memo` for a guided flow |
| `bulk-create --csv <file> --out <file>` / `import-csv` | Create many keys from a CSV and write an output CSV with generated URLs |
| `list` / `ls` | List keys (most recent first). Supports `--id-only`, `--url-only`, and `--output wide` |
| `show <id> [--copy] [--qr-terminal]` | Show one key; optionally copy URL / render QR in terminal. Supports `--id-only`, `--url-only` |
| `last` | Print the id of the most-recently-created key (also: pass `last` as `<id>` to any command) |
| `open [id] [--dashboard] [--trigger]` | Open the key's dashboard page in the browser (no id → dashboard root) |
| `hits <id> [-v] [--since DUR] [--ip IP] [--bot-only] [--follow]` | List hits with filters; `--follow` streams live |
| `watch [id] [-i N]` | Poll and print new hits; omit `id` for all keys (default: all keys, 5s) |
| `disable <id...>` / `enable <id...>` | Toggle one or more keys without losing history |
| `rm <id...> [--yes]` | Delete one or more keys + cascade hits (`mantis list --id-only \| xargs mantis rm -y`) |
| `download <id> [--docx \| --xlsx \| --pptx \| --pdf \| --folder \| --nfc-label \| --apple-wallet \| --svg \| --html \| --md \| --eml \| --ics \| --vcf] <path>` | Download artifacts for an existing key |
| `install <id> --type <type> [--out <path>]` | Generate a host-event or web-embed installer snippet |
| `monitor <id> --mode <off\|latch\|window> [--window <s>]` | Configure the Uptime Kuma status endpoint for a key |
| `reset <id>` | Reset a key's tripped (latched) monitor state |
| `status [id] [-w] [--tripped-only] [-i N]` | Monitor state. Without id: summary of all monitored keys. With id: full detail. `-w/--watch` refreshes continuously |
| `dest list <id>` | List a key's notification destinations |
| `dest add <id> <channel> <target>` | Add a notification destination (`dest` aliases `destinations`) |
| `dest rm <id> <dest-id>` | Remove one destination from a key |
| `dest test <id> [--yes]` | Fire a synthetic hit and report which destinations succeeded |
| `dest rotate-secret <id> <dest-id> [--yes]` | Rotate a webhook destination's HMAC signing secret (the new secret is shown once) |
| `audit log [-n <n>] [--since DUR] [--type TYPE] [--actor ID]` | List append-only audit events, most recent first (admin keys only) |
| `completion <bash\|zsh\|fish>` | Print shell completion script |
| `config list` / `get <key>` / `set <key> <value>` / `unset <key>` / `path` | Get/set machine-wide defaults (`output`, `color`); applied below explicit flags |
| `cloudflare login [--app URL]` | Auth via Cloudflare Access SSO (opens browser; needs local `cloudflared`) |
| `cloudflare logout` | Clear cached Cloudflare Access credentials |
| `cloudflare set-service-auth [--client-id … --client-secret …]` | Configure headless Cloudflare Access Service Auth |
| `cloudflare status` | Show Cloudflare Access auth state for the current server |
| `edge deploy [-- <wrangler args>]` | Deploy the mantis-edge Worker (wraps `wrangler deploy`), capture its `*.workers.dev` URL, and print the next steps; `--set-key` stores the AES key locally afterward, `--dir <path>` points at the worker directory |
| `edge mint [...opts]` | Mint a stateless edge URL. Run bare on a TTY for the interactive wizard; pass `--install <type>` to chain straight into installer generation |
| `edge install <url> --type <type>` | Generate an installer snippet (shell, plist, systemd unit, CSS, JS, NFC, Home Assistant, …) for a previously-minted edge URL |
| `plugin add <spec>` | Install a trusted local/GitHub CLI plugin that contributes installer types or file formats |
| `plugin list` / `ls` | List installed CLI plugins and what they provide |
| `plugin remove <name>` / `rm` | Uninstall a plugin |
| `plugin upgrade <name>` | Refresh a plugin from its source when it is not pinned to a commit |

### `new` options

- `-N, --notify <channel:target>` — notification destination; repeat for multiple destinations. Channels: `webhook`, `email`, `slack`, `discord`, `teams`
- `-w, --notify-webhook <url>` — shortcut for `--notify webhook:<url>`
- `-e, --notify-email <email>` — shortcut for `--notify email:<email>`
- `-r, --response-kind <kind>` — `gif` (default) / `empty` / `json` / `redirect` / `html`
- `--response-payload '<json>'` — payload for json/redirect/html
- `--expires-at <iso>` — auto-disable at this time
- `--copy` — copy the created key URL to the clipboard
- `--id-only` / `--url-only` — print only the created UUID or trigger URL
- `--qr <path.png>` — write a 512×512 PNG QR of the key URL
- `--docx <path>` — Word document with external-image mantis
- `--xlsx <path>` — Excel workbook with external-image mantis
- `--pptx <path>` — PowerPoint deck with external-image mantis
- `--pdf <path>` — PDF with combined `/OpenAction → /URI` and visible link
- `--folder <path>` — honey-directory `.zip` of 9 pre-baited files (Office trio + PDF + fake-creds .txt + Win/macOS shortcuts)
- `--svg <path>` — `.svg` image that fires on browser render (Immich/PhotoPrism)
- `--html <path>` — `.html` page that fires on browser open
- `--md <path>` — `.md` note that fires when rendered (Joplin/Trilium/Gitea)
- `--eml <path>` — `.eml` email that fires when opened in a mail client
- `--ics <path>` — `.ics` calendar event with image-attachment URL
- `--vcf <path>` — `.vcf` contact card with PHOTO URI

### Bulk CSV creation

Use `bulk-create` when you want to prepare many trigger URLs from a spreadsheet.
The command preserves your input columns and appends:
`mantis_memo`, `mantis_id`, `mantis_public_id`, `mantis_url`,
`mantis_created_at`, and `mantis_error`.

Example input:

```csv
area,device,notify_webhook
Front door,Scrypted person detection,https://hooks.example.com/front-door
Garage,Unexpected device online,https://hooks.example.com/garage
Kitchen,Home Assistant automation,https://hooks.example.com/kitchen
```

Create URLs:

```bash
mantis bulk-create \
  --csv smart-home-areas.csv \
  --out smart-home-areas-with-urls.csv \
  --memo-template "{{area}} - {{device}}"
```

Useful columns:

| Column | Purpose |
|---|---|
| `memo` | Memo for the created key. If missing, `area` or `name` is used |
| `area`, `name` | Friendly fallback labels for the key memo |
| `notify` | Semicolon-separated destinations like `webhook:https://...;email:ops@example.com` |
| `notify_webhook`, `notify_email`, `notify_slack`, `notify_discord`, `notify_teams` | Per-row destinations |
| `response_kind` | Per-row `gif`, `empty`, `json`, `redirect`, or `html` |
| `response_payload` | Per-row JSON payload for `json`, `redirect`, or `html` responses |
| `expires_at` | Per-row ISO timestamp for auto-disable |

Useful options:

- `--memo-column <name>` — choose the memo column explicitly
- `--memo-template "{{area}} - {{device}}"` — build memos from multiple columns
- `--notify`, `--notify-webhook`, `--notify-email` — add destinations to every row
- `--response-kind`, `--response-payload`, `--expires-at` — defaults for every row
- `--concurrency <n>` — create up to 20 keys in parallel, default `4`
- `--dry-run` — validate the CSV and preview memos without creating keys
- `--fail-fast` — stop after the first row-level failure

Rows that fail are kept in the output CSV with `mantis_error` filled in. The
command exits non-zero when any row fails.

### Smart home installers

```bash
mantis install last --type homeassistant --out mantis-ha.yaml
mantis install last --type scrypted --out mantis-scrypted.js
```

Home Assistant snippets generate a `rest_command` and example automations for
door sensors, automation-triggered events, unexpected device-online sensors, and
Scrypted person-detected sensors. Scrypted snippets generate a Script template
that listens to selected Scrypted device events directly.

Profiles are resolved when the snippet is generated. The generated YAML/JS file
contains a literal trigger URL for the key on that profile's server; it does not
look up CLI profiles at runtime. To target a specific server, choose the profile
on the `install` command:

```bash
mantis --profile prod install last --type homeassistant --out mantis-ha-prod.yaml
mantis --profile lab install last --type homeassistant --out mantis-ha-lab.yaml
```

To notify more than one Mantis server from the same smart-home event, generate
one snippet/key per profile and call both generated URLs from the automation.

### Global flags

- `--base-url <url>` — override stored base URL for one command (env: `MANTIS_BASE_URL`)
- `--key <key>` — override stored API key for one command (env: `MANTIS_API_KEY`)
- `-p, --profile <name>` — use a named profile (env: `MANTIS_PROFILE`)
- `--json` — emit machine-readable JSON to stdout (errors go to stderr)
- `--output table|json|wide` — choose table, JSON, or wider human table output
- `-q, --quiet` — suppress human-readable stdout
- `--no-headers` — hide table headers
- `--color auto|always|never` — colorize output (env: `NO_COLOR`, `FORCE_COLOR`); `auto` colors only on a TTY
- `--debug` — print resolved target + stack trace + HTTP details on failure (env: `MANTIS_DEBUG`)
- `--timeout <duration>` — per-request timeout, e.g. `500ms`, `5s`, `1m`
- `--retries <n>` — retry transient GET failures, from `0` to `5`

Persist defaults for `--output` and `--color` so scripts/sessions don't repeat
them (explicit flags still win): `mantis config set output json` (see the
`config` rows in [Commands](#commands)). Set `MANTIS_ASCII=1` to force ASCII
glyphs on terminals that can't render `✓`/`…`/`·`.

### Short-id resolution

Every command that takes `<id>` accepts:

- a full UUID (`abc12345-c721-457a-a591-e368e5ebc926`)
- a hex prefix of ≥4 chars (`abc12345`); resolution errors if ambiguous
- the literal token `last` — the most-recently-created key

So once you've run `mantis new "test"` you can immediately:

```bash
mantis hits last --follow
mantis show last --qr-terminal
mantis open last
mantis dest add last webhook https://hooks.example.com/foo
mantis dest test last --yes
mantis status last
```

The id prefix path costs one extra `listKeys` call when the input isn't a full UUID; full UUIDs skip the lookup.

### Guided creation

Run `mantis new` with no memo to use an interactive flow. It prompts for memo, response kind, notification destinations, expiry, and optional file outputs. Prompts write to stderr so stdout stays clean for scripts.

### Shell completion

```bash
# zsh
mantis completion zsh > ~/.zsh/completions/_mantis

# bash
mantis completion bash > ~/.local/share/bash-completion/completions/mantis

# fish
mantis completion fish > ~/.config/fish/completions/mantis.fish
```

## Profiles — multiple mantis instances

The CLI can store credentials for any number of mantis instances (e.g. one standard server + one edge worker, or prod/staging/personal, etc.) and switch between them without re-logging-in.

```bash
# Log in to the prod server (creates and selects the 'prod' profile)
mantis --profile=prod login -u https://mantis.example.com

# Add a second profile without switching to it
mantis --profile=staging login -u https://staging.example.com --no-switch

# Show all profiles (current marked with *)
mantis profile list
# * prod             https://mantis.example.com
#     key:   mantis_live_abc123…
#   staging          https://staging.example.com
#     key:   mantis_live_xyz789…

# Switch the active profile
mantis profile use staging
mantis list                    # talks to staging now

# Run one command against a non-current profile
mantis --profile=prod hits <id>

# Same via env var (useful in scripts)
MANTIS_PROFILE=prod mantis list

# Show one profile's details
mantis profile show prod

# Remove a profile + its keychain entry
mantis profile rm staging --yes

# Wipe everything
mantis logout --all
```

### Profiles and generated scripts

Profiles only affect CLI commands while the command is running. Any generated
artifact or installer contains the final URL it should ping.

For example:

```bash
mantis --profile prod install last --type shell --out prod-shell.sh
mantis --profile lab install last --type homeassistant --out lab-ha.yaml
```

`prod-shell.sh` pings the trigger URL from the `prod` key/server. `lab-ha.yaml`
pings the trigger URL from the `lab` key/server. After generation, neither file
knows about `--profile`, `MANTIS_PROFILE`, or the local keychain.

That same rule applies to Home Assistant, Scrypted, NFC tags, host startup
scripts, and downloaded bait files: regenerate from the desired profile when you
want the artifact to report to a different Mantis instance.

### Linking an edge worker to a profile

Each profile can optionally remember a default `mantis-edge` Cloudflare Worker URL. `mantis edge mint` uses it when `--worker` is omitted:

```bash
# Set up the standard mantis server profile
mantis --profile=prod login -u https://mantis.example.com

# Store the edge worker's AES key (one-time, per worker URL)
mantis edge set-key https://edge.example.workers.dev "$(mantis edge keygen | head -1)"

# Link the edge worker to the prod profile
mantis profile set-edge prod --worker=https://edge.example.workers.dev

# Now `edge mint` uses the linked worker by default
mantis edge mint --webhook=https://hooks.example.com/xyz --memo="exfil canary"
# https://edge.example.workers.dev/c/<sealed-blob>

# Override per-call
mantis --profile=staging edge mint --worker=https://other-edge.workers.dev --webhook=...
```

### Resolution order

When a command needs to know which mantis to talk to, it picks the first match:

1. `--base-url <url>` (ad-hoc; no profile lookup, no CF Access auto-config)
2. `--profile <name>` flag or `MANTIS_PROFILE` env var (the named profile must exist)
3. `MANTIS_BASE_URL` env var (ad-hoc; for CI / containers with no stored profile)
4. Stored `currentProfile`

API key resolution:

1. `--key <key>` flag
2. `MANTIS_API_KEY` env var
3. Keychain entry indexed by the resolved base URL (`mantis-cli` service, account = base URL)

`MANTIS_BASE_URL` + `MANTIS_API_KEY` cover headless use (CI runners, containers)
where there's no interactive `mantis login` and no OS keychain — and keep the
key out of argv, where `--key` would leak it into `ps` output and shell history:

```bash
MANTIS_BASE_URL=https://mantis.example.com MANTIS_API_KEY=mantis_live_… mantis list
```

The keychain layout means **the same API key works across profiles that share a base URL** — useful when you have prod + a prod-with-different-CF-Access-mode profile pointing at the same server.

### Where it's stored

- Config file: `$XDG_CONFIG_HOME/mantis/config.json` (or `~/.config/mantis/config.json`), mode `0600`
- API keys: OS keychain (`mantis-cli` service, account = base URL) — never written to disk
- Cloudflare Service Auth secrets: OS keychain (`mantis-cli-cf` service, account = base URL)

Existing pre-profile configs (flat `{baseUrl, keyPrefix, …}`) migrate automatically to the new shape on first read, landing under a profile named `default`. No re-login needed.

## Backup & restore (migrating to a new machine)

The config file is plain JSON and trivially `scp`-able, but the secrets that actually make a CLI install work — API keys, Cloudflare Service-Auth credentials, edge AES keys — live in the OS keychain and can't be copied that way. `mantis backup` and `mantis restore` cover the full set: a passphrase-encrypted JSON bundle containing every profile's secrets plus the plugin manifest, suitable for committing to a private git-crypt repo or stashing in a password manager.

```bash
# On the old machine:
mantis backup --out ~/Vault/mantis-backup.json
# prompts for a passphrase twice (typed input echoes — protected at rest, not on-screen)

# On the new machine — install the CLI first, then:
mantis restore ~/Vault/mantis-backup.json
# prompts for the passphrase once
```

The bundle uses scrypt (N=32768, r=8, p=1) → AES-256-GCM. Salt + nonce are random per backup, so two backups of the same data produce different ciphertexts. The format tag (`mantis-backup-v1`) is checked on restore so we can evolve the format without silently breaking old bundles.

**What's included:**

- Every profile's `baseUrl`, `keyPrefix`, full `mantis_live_…` API key, Cloudflare Access mode + app URL + Service-Auth client-id/secret, linked edge worker URL, and edge AES key
- The active-profile pointer
- Plugin manifest: each plugin's `name`, `source` (GitHub `owner/repo`), pinned commit SHA, and version. **`restore` re-installs plugins via `mantis plugin add <source>@<ref>`** — the bundle does NOT carry the plugin contents themselves, so the new machine needs network access to GitHub for the re-install.

**What's NOT included:**

- Local-path plugins (`mantis plugin add ./some/path`) — those aren't reproducible on another machine; `backup` lists them as skipped.
- `~/.cloudflared/` cached JWTs — owned by `cloudflared`, regenerated on next login.

**Flag reference:**

| Flag | What it does |
|---|---|
| `mantis backup --out <file>` | Where to write the bundle. Default `./mantis-backup.json`. |
| `mantis backup --only <name>` | Back up just one profile. Default is all profiles. |
| `mantis backup --passphrase-stdin` | Read passphrase from stdin (for scripts piping a vault into the CLI). |
| `mantis backup --passphrase-env <VAR>` | Read passphrase from the named env var. |
| `mantis restore <file>` | Decrypt + restore. By default, existing profiles on the target machine are kept; bundle entries with the same name are skipped. |
| `mantis restore --overwrite` | Replace existing profiles + keychain entries when names collide. |
| `mantis restore --skip-plugins` | Don't re-install plugins (faster restore; you can run `mantis plugin add` manually later). |
| `mantis restore --passphrase-stdin` / `--passphrase-env <VAR>` | Same as on backup. |

**Inline `--passphrase <value>` is intentionally not offered** — would leak into shell history and process listings. Use one of the stdin / env-var forms for automation.

**On safety:** the bundle is safe to commit to a private repo or store in a vault provided you can keep the passphrase out of the same blast radius. If the file leaks but the passphrase doesn't, contents stay confidential. If the passphrase leaks, the contents are recoverable. Rotate API keys (`mantis login` re-runs) if you suspect either has been compromised.

## Local state reference

Everything the CLI persists about your accounts lives in two places: a plaintext config file (zero secrets) and OS keychain entries (every secret). No tokens are kept in environment files, shell history, or shell rc files.

### The config file

Path: `$XDG_CONFIG_HOME/mantis/config.json`, falling back to `~/.config/mantis/config.json`. Permissions `0600`. Written by `setProfile()` / `useProfile()` in `cli/src/lib/config.ts`.

Shape:

```jsonc
{
  "currentProfile": "prod",
  "profiles": {
    "prod": {
      "baseUrl": "https://mantis.example.com",         // required
      "keyPrefix": "mantis_live_UwQxWE",               // first 18 chars; display only
      "cloudflareAccessAppUrl": "https://mantis.example.com",  // optional
      "cloudflareAccessMode": "sso",                   // "sso" | "service-auth" | absent
      "edgeWorkerUrl": "https://edge.example.workers.dev"      // optional; default for `mantis edge mint`
    },
    "staging": {
      "baseUrl": "https://staging.example.com",
      "keyPrefix": "mantis_live_aBcDeF"
    }
  }
}
```

What's *not* there:

- Full API keys — only the 18-character `keyPrefix` for display
- Cloudflare client IDs / secrets — keychain only
- Edge AES keys — keychain only

You can hand-edit this file, sync it via dotfiles (it has no secrets), or `cat` it to recover from a broken state. Re-running `mantis login --profile <name>` rewrites the affected slot.

Legacy `{baseUrl, keyPrefix, …}` configs (pre-profile flat shape) auto-migrate to the new shape on first read; the original file is overwritten in-place with the new layout. No `mantis login` re-run required.

### Keychain entries

Three separate keychain services, each keyed by URL (not profile name), so multiple profiles pointing at the same URL transparently share their credential:

| Service | Account | Password | Set by | Cleared by |
|---|---|---|---|---|
| `mantis-cli` | mantis server base URL | Full `mantis_live_…` API key | `mantis login`, `mantis --profile=<name> login` | `mantis logout`, `mantis profile rm` |
| `mantis-cli-cf` | mantis server base URL | JSON `{"client_id": "…", "client_secret": "…"}` (Cloudflare Access Service Auth) | `mantis cloudflare set-service-auth` | `mantis cloudflare logout`, `mantis logout` |
| `mantis-cli-edge` | edge worker base URL | 32-byte AES-GCM key, base64url-encoded | `mantis edge set-key <url> [key]` (prompts if `[key]` omitted) | `mantis edge delete-key --worker <url>` |

Backing keystore by platform (via [`@napi-rs/keyring`](https://www.npmjs.com/package/@napi-rs/keyring)):

- **macOS** → Keychain (visible in *Keychain Access.app* under "passwords")
- **Linux** → Secret Service via D-Bus (GNOME Keyring, KWallet, KeePassXC's secret service)
- **Windows** → Credential Manager

### Inspecting from the shell

**macOS** (`security`):

```bash
# Find the password for a specific account
security find-generic-password -s mantis-cli      -a https://mantis.example.com  -w
security find-generic-password -s mantis-cli-cf   -a https://mantis.example.com  -w
security find-generic-password -s mantis-cli-edge -a https://edge.example.workers.dev -w

# Or browse all mantis entries
security dump-keychain ~/Library/Keychains/login.keychain-db \
  | grep -B1 'mantis-cli'

# Delete one
security delete-generic-password -s mantis-cli -a https://mantis.example.com
```

**Linux** (`secret-tool` from libsecret-tools):

```bash
# Lookup
secret-tool lookup service mantis-cli      account https://mantis.example.com
secret-tool lookup service mantis-cli-edge account https://edge.example.workers.dev

# Search across services
secret-tool search service mantis-cli

# Delete
secret-tool clear service mantis-cli account https://mantis.example.com
```

**Windows** (PowerShell, via [`CredentialManager`](https://www.powershellgallery.com/packages/CredentialManager) module):

```powershell
Get-StoredCredential -Target "mantis-cli"
Remove-StoredCredential -Target "mantis-cli/https://mantis.example.com"
```

### What lives outside mantis's reach

| Item | Owner | Where |
|---|---|---|
| Cloudflare Access SSO JWTs | `cloudflared` binary | `~/.cloudflared/` — short-lived (24h default); mantis shells out to `cloudflared access token` to read |
| Browser cookies for the dashboard | Your browser | Per-profile cookie store; cleared by `mantis logout` only on the server side |
| `npx wrangler dev` `MANTIS_EDGE_KEY` | `wrangler` | `mantis-edge/.dev.vars` — plaintext, gitignored; only present on dev machines |
| Git config / SSH keys | git / OpenSSH | Untouched |

### Reset everything

```bash
mantis logout --all          # removes every profile's keychain entry + deletes config.json
mantis edge delete-key --worker=https://edge1.example.workers.dev
mantis edge delete-key --worker=https://edge2.example.workers.dev
# edge keys are URL-keyed, not profile-keyed — `--all` doesn't touch them
```

If you want to nuke everything by hand:

```bash
rm -f ~/.config/mantis/config.json

# macOS
security delete-generic-password -s mantis-cli      2>/dev/null
security delete-generic-password -s mantis-cli-cf   2>/dev/null
security delete-generic-password -s mantis-cli-edge 2>/dev/null

# Linux
secret-tool search service mantis-cli      | xargs -r secret-tool clear service mantis-cli
secret-tool search service mantis-cli-cf   | xargs -r secret-tool clear service mantis-cli-cf
secret-tool search service mantis-cli-edge | xargs -r secret-tool clear service mantis-cli-edge
```

### Threat model summary

| Attacker capability | Can read | Cannot read |
|---|---|---|
| Only your `~/.config/mantis/config.json` (e.g. compromised cloud backup) | Base URLs, key prefixes, CF Access app URLs, edge worker URLs | Anything that could authenticate — config holds zero secrets |
| Interactive shell on your unlocked machine | Everything you can — full API keys, CF Service Auth secrets, edge AES keys | — |
| Stolen but locked laptop, disk encrypted at rest | Nothing | Everything; the OS keychain is encrypted with your login credential / Secure Enclave / TPM |

## Cloudflare Access auth (when your mantis API is gated)

If you've put `/api/*` behind Cloudflare Access (see [mantis-docs: deployment/cloudflare.md](https://github.com/privacykey/mantis-docs/blob/main/deployment/cloudflare.md#step-6-optional--cloudflare-access)), the CLI needs to authenticate to Cloudflare *before* it can reach the mantis API. Two modes:

**SSO** (interactive; uses your real Cloudflare identity):
```bash
brew install cloudflared
mantis cloudflare login --app=https://mantis.your-domain.com
mantis list   # CLI auto-injects a fresh CF JWT on every /api/* request
```
JWTs are short-lived (Cloudflare default: 24h). Re-run `mantis cloudflare login` when expired.

**Service Auth** (headless; pre-shared key pair, suitable for CI):
```bash
# Generate key at: Cloudflare Zero Trust → Access → Service Auth
mantis cloudflare set-service-auth --client-id <id>.access --client-secret <secret>
mantis list   # CLI injects CF-Access-Client-Id + CF-Access-Client-Secret on every request
```

All Cloudflare auth state lives on your machine. The mantis server is unaware of Cloudflare — Access validates at the edge before the request ever reaches mantis.

For Tailscale split deployments, use the private Serve hostname for `mantis login`
and dashboard/API commands. `mantis open` now uses that private base URL for
dashboard links, while `mantis open --trigger` still opens the public trigger
URL. Run `mantis doctor --public-url https://mantis-public.<tailnet>.ts.net`
to verify public-only paths return 404 for `/login` and `/api/*`.

## Scripting

`--json` outputs the same shape as the HTTP API. For shell pipelines, the
id/url-only flags avoid needing `jq` for the common cases:

```bash
ID=$(mantis --json new "ephemeral" | jq -r .id)
mantis --json hits "$ID" | jq '.data[] | {at: .occurred_at, ip}'

ID=$(mantis new "daily bait" --id-only)
URL=$(mantis show "$ID" --url-only)
mantis list --id-only
```

`rm`, `disable`, and `enable` accept multiple ids, so the producer/consumer
pipeline works directly:

```bash
# delete every key whose id you pipe in (-y because stdin isn't a TTY)
mantis list --id-only | xargs mantis rm -y

# without -y on a pipe, rm refuses with a non-zero exit instead of silently
# deleting nothing
```

`--follow` / `watch` become NDJSON streams under `--json` (one hit object per
line; the "following…/watching…" banner stays on stderr):

```bash
mantis hits last --follow --json | jq -c '{at: .occurred_at, ip}'
mantis watch --json | jq -c .
```

### Exit codes

Failures exit non-zero, with a distinct code per error class so scripts can
branch without parsing stderr (`0` success, `1` generic):

| Code | Meaning |
|---|---|
| `3` | usage error (bad flag/argument value) |
| `4` | auth (missing/invalid credentials, 401/403, no profile) |
| `5` | not found (unknown key id/prefix, 404) |
| `6` | network (connection failed or timed out) |
| `7` | server error (5xx) |

(`detect` additionally uses `2` for "artifacts found", grep-style.)

### Headless credentials

For CI/containers with no keychain, supply credentials via env vars (see
[Resolution order](#resolution-order)) and feed secrets through stdin rather
than argv so they don't leak into `ps` / shell history:

```bash
export MANTIS_BASE_URL=https://mantis.example.com MANTIS_API_KEY=mantis_live_…
mantis list

# storing credentials non-interactively
echo "$MANTIS_API_KEY" | mantis login --url "$MANTIS_BASE_URL" --key-stdin
echo "$EDGE_KEY"       | mantis edge set-key https://edge.example.workers.dev --key-stdin
echo "$CF_SECRET"      | mantis cloudflare set-service-auth --client-id abc.access --client-secret-stdin
```

## Single-binary build (optional)

If you have Bun installed:

```bash
bun build --compile --target=bun-darwin-arm64 \
  --outfile dist/mantis src/index.ts
```

This produces a standalone executable with no Node runtime requirement.
