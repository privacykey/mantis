<p align="center">
  <img src=".github/assets/banner.png" alt="mantis" width="640">
</p>

<p align="center">
  <a href="https://github.com/privacykey/mantis/releases?q=cli-v"><img alt="CLI release" src="https://img.shields.io/github/v/release/privacykey/mantis?filter=cli-v*&label=CLI&color=2f7df0"></a>
  <a href="https://github.com/privacykey/homebrew-tap"><img alt="Homebrew tap" src="https://img.shields.io/badge/brew-privacykey%2Ftap%2Fmantis-FBB040?logo=homebrew&logoColor=white"></a>
  <a href="https://github.com/privacykey/mantis/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/privacykey/mantis/actions/workflows/ci.yml/badge.svg"></a>
  <a href="./mantis-edge/"><img alt="Cloudflare Workers edge" src="https://img.shields.io/badge/edge-Cloudflare%20Workers-F38020?logo=cloudflare&logoColor=white"></a>
</p>

> [!WARNING]
> **Beta.** APIs, DB schema, and CLI flags may still change before v1.0. Components are versioned independently — CLI `v0.1.6`, full server `v0.1.1`, edge `v0.1.3` at time of writing. Pin a release tag for stability.

Self-hostable mantis key service. API-first.

You mint a unique URL; when something fetches it, you get notified through the destinations you configure. Useful for honeypot files on shared drives, fake credentials in `.env`s, SSH-login alarms on jump boxes, detecting site clones, or any "did someone touch the thing they shouldn't" tripwire.

Highlights:

- **File keys** in 10 formats (`.docx` / `.xlsx` / `.pptx` / `.pdf` / `.svg` / `.html` / `.md` / `.eml` / `.ics` / `.vcf`) plus a 9-file honey-directory `.zip` and Apple Wallet `.pkpass` passes (install / uninstall / fetch callbacks each fire the key)
- **Host-event installers** — shell, sudo, login, boot, wake, network — for macOS, Linux, and Windows, with parsed `X-Mantis-*` context including SSH client IP
- **Web canaries** — CSS-background + JS clone-detector — plus NFC NDEF tag URLs and printable QR/NFC sticker labels
- **Smart-home triggers** via Home Assistant, Scrypted, and an optional LAN watcher
- **Smart-home actions** — `home_assistant` destination posts to a HA webhook automation, so a hit can flip a switch (e.g. cut a VLAN via the OPNsense integration), fire a scene, or push a phone notification (`mantis install <key> --type homeassistant-receiver` prints a ready-to-paste automation skeleton)
- **Direct notification destinations** — webhook, email, Slack, Discord, Teams — with a Postgres-backed retry queue and per-key dedup
- **Optional stateless variant** ([`mantis-edge/`](./mantis-edge/README.md)) — a Cloudflare Worker that decrypts URLs at the edge, no DB to host
- **Uptime Kuma integration** — per-key status URL flips on hit, watched by Kuma for 80+ notification channel fan-out

## Contents

- [Getting started](#getting-started) — [stateful server](#quickstart-stateful-server) or [stateless edge](#quickstart-no-server--edge)?
- [Run from source](#run-from-source) — for contributors
- [Components](#components) — in-repo docs for each part
- [Docs](#docs) — full prose documentation

## Getting started

**Stateful server or stateless edge?** Run the full **server** (`docker compose`, Postgres-backed) when you want the web dashboard, notification queue, file/host-event keys, and history. Run the **edge** ([`mantis-edge/`](./mantis-edge/README.md)) — a Cloudflare Worker that decrypts URLs at the edge with no DB to host — when you only need fire-and-forget hit alerts and want zero infrastructure.

The fastest path either way is the guided CLI: `mantis init` asks server-or-edge and walks you through login and your first key.

```bash
brew install privacykey/tap/mantis
mantis init
```

### Quickstart (stateful server)

```bash
git clone https://github.com/privacykey/mantis && cd mantis
cp .env.example .env
# Generate the required hashing pepper — without it the server crash-loops on boot
echo "MANTIS_API_KEY_PEPPER=$(openssl rand -base64 32)" >> .env
docker compose up -d
# Wait for the boot banner, then read the one-time bootstrap admin key
docker compose logs -f mantis | grep -m1 -A1 "bootstrap API key"
```

The `mantis_live_...` value printed above is the **bootstrap admin key** — it is both your CLI token and your dashboard login. To know it up front instead, pre-set `BOOTSTRAP_API_KEY=mantis_live_...` in `.env` before the first boot.

Open <http://localhost:3000> and paste that same key to sign in to the web dashboard. Then log in the CLI and mint a key:

```bash
mantis --key mantis_live_... login --url http://localhost:3000
mantis new "first mantis" -w http://localhost:3000/inbox/demo
```

This is fine for evaluation but **don't rely on a laptop deploy for canaries that need to fire when you're away from your machine.** For a real public-reachable deploy — Tailscale Funnel, Cloudflare Tunnel, Railway, Fly.io, or Render — see **[deployment options](https://github.com/privacykey/mantis-docs/blob/main/deployment/README.md)**.

### Quickstart (no server / edge)

No DB to host: deploy the Cloudflare Worker, then mint URLs that decrypt at the edge.

```bash
mantis edge keygen                 # generate the AES key
mantis edge set-key <worker-url>   # link the deployed Worker
mantis edge mint                   # interactive wizard for a stateless URL
```

See **[`mantis-edge/README.md`](./mantis-edge/README.md)** for Worker deploy and full `mantis edge` usage.

## Run from source

For contributors hacking on the web dashboard / server:

```bash
pnpm install
cp .env.example .env          # set DATABASE_URL and generate MANTIS_API_KEY_PEPPER
pnpm run db:migrate
pnpm dev
```

Generate the pepper with `openssl rand -base64 32` and add it as `MANTIS_API_KEY_PEPPER` in `.env`.

## Components

Each part of the repo has its own reference:

- **CLI** — [`cli/README.md`](./cli/README.md) (full reference) and [`cli/COMMAND_MAP.md`](./cli/COMMAND_MAP.md) (command map)
- **Edge worker** — [`mantis-edge/README.md`](./mantis-edge/README.md)
- **IoT / LAN helper** — [`iot-helper/README.md`](./iot-helper/README.md)
- **Benchmarks** — [`bench/README.md`](./bench/README.md)
- **Deploy assets** — [`deploy/`](./deploy/) (Fly.io and Render examples)

## Docs

Full documentation: **[github.com/privacykey/mantis-docs](https://github.com/privacykey/mantis-docs)**.

Common starting points:

- [Getting started](https://github.com/privacykey/mantis-docs/blob/main/getting-started.md) — five steps from `brew install` to first key
- [Use cases](https://github.com/privacykey/mantis-docs/blob/main/use-cases.md) — defensive / detective / operational / adversarial patterns
- [HTTP API](https://github.com/privacykey/mantis-docs/blob/main/api.md) — endpoints, response kinds, webhook payload shape
- [File keys](https://github.com/privacykey/mantis-docs/blob/main/file-keys.md) and [host-event keys](https://github.com/privacykey/mantis-docs/blob/main/host-events.md)
- [Updating](https://github.com/privacykey/mantis-docs/blob/main/updating.md) — update commands per component

## License

MIT License. See [`LICENSE`](./LICENSE).
