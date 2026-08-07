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
./scripts/setup.sh   # creates .env with a random DB password + API-key pepper
docker compose up -d
# Wait for the boot banner, then read the one-time bootstrap admin key
docker compose logs -f mantis | grep -m1 -A1 "bootstrap API key"
```

`setup.sh` is idempotent — re-running it leaves existing secrets untouched. Postgres is never published to the host (it sits on an internal-only docker network), and the DB password is the single value you set in `.env`; the app's `DATABASE_URL` is derived from it.

The `mantis_live_...` value printed above is the **bootstrap admin key** — it is both your CLI token and your dashboard login. To know it up front instead, pre-set `BOOTSTRAP_API_KEY=mantis_live_...` in `.env` before the first boot.

Open <http://localhost:3000> and paste that same key to sign in to the web dashboard. Then log in the CLI and mint a key:

```bash
mantis --key mantis_live_... login --url http://localhost:3000
mantis new "first mantis" -w http://localhost:3000/inbox/demo
```

This is fine for evaluation but **don't rely on a laptop deploy for canaries that need to fire when you're away from your machine.** For a real public-reachable deploy — Tailscale Funnel, Cloudflare Tunnel, Railway, Fly.io, or Render — see **[deployment options](https://github.com/privacykey/mantis-docs/blob/main/deployment/README.md)**.

For Fly.io specifically, one command provisions the app, a Managed Postgres
cluster, the secrets and the first admin key:

```bash
bash deploy/fly-launch.sh --app my-mantis --region iad
```

Add `--dry-run` to see every command it would run first. See
[`deploy/fly.toml.example`](./deploy/fly.toml.example) for the config it
generates, and [`.github/workflows/fly-deploy.yml`](./.github/workflows/fly-deploy.yml)
to make later pushes deploy themselves.

> **Serve it over HTTPS, never plain HTTP.** Mantis authenticates with an API key sent as a bearer token and a session cookie — over plain HTTP on a routable address both travel in cleartext and can be sniffed. Put it behind a tunnel (the `tailscale` / `cloudflared` compose profiles terminate TLS for you) or a TLS reverse proxy. The compose setup keeps Postgres on an internal-only network with no published port, so the database is never reachable from the host or LAN.

### Quickstart (no server / edge)

No DB to host: deploy the Cloudflare Worker, then mint URLs that decrypt at the edge.

```bash
mantis edge keygen                 # generate the AES key
mantis edge set-key <worker-url>   # link the deployed Worker
mantis edge mint                   # interactive wizard for a stateless URL
```

To arm a whole machine at once — one URL per host alarm (login, sudo, wake,
boot, network) plus an install bundle directory:

```bash
mantis edge device --os macos --name web01 --webhook <url> --bundle ./web01
```

Two server-backed properties don't cross over, and the command says so on every
run: without a database there is no idempotent re-mint (re-running issues a
fresh set of URLs), and the worker can't remember the last hit, so vectors that
dedupe server-side — network attach — are chattier at the edge. The stateful
equivalent is `mantis device new`, which keeps both.

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
- **Deploy assets** — [`deploy/`](./deploy/) (one-command Fly.io launch, Render example)
- **MDM fleet canaries** — [`deploy/kandji/`](./deploy/kandji/) (one key per managed Mac, terminal-open alerts)

## Fleet / MDM provisioning

`POST /api/keys` is idempotent when you pass an `external_id` (e.g. a machine
serial): the first call mints the key, every re-run returns the same one
(`200` + `"reused": true`), so MDM scripts can enroll on every check-in
without minting duplicates. Pair it with an **enrollment-scoped API key**
(`POST /api/api-keys` with `"scope": "enroll"`) — a create-only credential
that's safe to embed in fleet scripts: if extracted from a device it cannot
list, read, disable, or delete keys, read hits, or log in to the dashboard.

[`deploy/kandji/`](./deploy/kandji/README.md) has a ready-made Kandji Custom
Script that gives every Mac its own canary and pings it whenever an
interactive terminal opens, plus a central pre-provisioning script driven by
the Kandji API.

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
