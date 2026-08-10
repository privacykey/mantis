<p align="center">
  <img src=".github/assets/banner.png" alt="mantis" width="640">
</p>

<h1 align="center">mantis</h1>

<p align="center">Self-hostable canary key service. API-first.</p>

<p align="center">
  <a href="https://github.com/privacykey/.github/blob/main/STATUS.md#mantis"><img alt="Project status" src="https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2Fprivacykey%2F.github%2Fmain%2Fbadges%2Fmantis.json"></a>
  <a href="https://github.com/privacykey/mantis/releases/latest"><img alt="Release" src="https://img.shields.io/github/v/release/privacykey/mantis?label=release"></a>
  <a href="LICENSE"><img alt="Licence" src="https://img.shields.io/github/license/privacykey/mantis?label=licence"></a>
  <a href="https://github.com/privacykey/mantis/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/privacykey/mantis/ci.yml?branch=main&label=ci"></a>
</p>

<!-- disclosure:start -->
> [!WARNING]
> **Pre-1.0 — no stable release yet.** Anything can change in any release, including a patch: APIs, CLI flags, config keys, file formats, and data already on disk. Keep your own backups.
> **Project status.** The badge above is generated from [the privacykey status list](https://github.com/privacykey/.github/blob/main/STATUS.md), which says what I promise for this project and every other one.
<!-- disclosure:end -->

> [!CAUTION]
> **Serve it over HTTPS, never plain HTTP.** Mantis authenticates with an API key sent as a bearer token and a session cookie — over plain HTTP on a routable address both travel in cleartext and can be sniffed. Put it behind a tunnel (the `tailscale` / `cloudflared` compose profiles terminate TLS for you) or a TLS reverse proxy.

---

You mint a unique URL; when something fetches it, you get notified through the destinations you configure. Useful for honeypot files on shared drives, fake credentials in `.env`s, SSH-login alarms on jump boxes, detecting site clones, or any "did someone touch the thing they shouldn't" tripwire.

There are two ways to run it. The full **server** (`docker compose`, Postgres-backed) gives you the web dashboard, the notification queue, file and host-event keys, and hit history. The **edge** variant ([`mantis-edge/`](./mantis-edge/README.md)) is a Cloudflare Worker that decrypts URLs at the edge with no database to host. Use it when you only need fire-and-forget hit alerts and want zero infrastructure.

Components are versioned independently: the server, the CLI, and the edge worker each carry their own version and release on their own cadence.

## What it does

- **File keys** in 10 formats (`.docx` / `.xlsx` / `.pptx` / `.pdf` / `.svg` / `.html` / `.md` / `.eml` / `.ics` / `.vcf`) plus a honey-directory `.zip` and Apple Wallet `.pkpass` passes (install / uninstall / fetch callbacks each fire the key)
- **Host-event installers** — shell, sudo, login, boot, wake, network — for macOS, Linux, and Windows, with parsed `X-Mantis-*` context including SSH client IP
- **Web canaries** — CSS-background and JS clone-detector — plus NFC NDEF tag URLs and printable QR/NFC sticker labels
- **Smart-home triggers** via Home Assistant, Scrypted, and an optional LAN watcher
- **Smart-home actions** — the `home_assistant` destination posts to a HA webhook automation, so a hit can flip a switch, fire a scene, or push a phone notification; `mantis install <key> --type homeassistant-receiver` prints the automation skeleton
- **Direct notification destinations** — webhook, email, Slack, Discord, Teams — with a Postgres-backed retry queue and per-key dedup
- **Uptime Kuma integration** — a per-key status URL flips on hit, so Kuma can fan out to its own notification channels
- **Fleet provisioning** — idempotent key creation keyed on an `external_id`, plus create-only enrollment API keys safe to embed in MDM scripts. See [`docs/FLEET-PROVISIONING.md`](./docs/FLEET-PROVISIONING.md)

## Get it

The fastest path either way is the guided CLI: `mantis init` asks server-or-edge and walks you through login and your first key.

```bash
brew install privacykey/tap/mantis
mantis init
```

To stand the server up yourself:

```bash
git clone https://github.com/privacykey/mantis && cd mantis
./scripts/setup.sh   # creates .env with a random DB password + API-key pepper
docker compose up -d
```

`setup.sh` is idempotent — re-running it leaves existing secrets untouched. Postgres is never published to the host; it sits on an internal-only docker network.

Full walkthrough, including reading the bootstrap admin key, the one-command Fly.io launch and the stateless edge path: [`docs/GETTING-STARTED.md`](./docs/GETTING-STARTED.md).

This is fine for evaluation, but **don't rely on a laptop deploy for canaries that need to fire when you're away from your machine.**

Every component — CLI, edge worker, LAN helper, benchmarks, deploy assets — has its own reference, indexed at the end of [`docs/GETTING-STARTED.md`](./docs/GETTING-STARTED.md).

## Docs

The prose documentation lives in [`privacykey/docs-mantis`](https://github.com/privacykey/docs-mantis). It is a Mintlify source and the rendered site is not live yet, so these link to the Markdown on GitHub.

- [Getting started](https://github.com/privacykey/docs-mantis/blob/main/getting-started.md) — five steps from `brew install` to first key
- [Use cases](https://github.com/privacykey/docs-mantis/blob/main/use-cases.md) — defensive, detective, operational and adversarial patterns
- [HTTP API](https://github.com/privacykey/docs-mantis/blob/main/api.md) — endpoints, response kinds, webhook payload shape
- [File keys](https://github.com/privacykey/docs-mantis/blob/main/file-keys.md), [host-event keys](https://github.com/privacykey/docs-mantis/blob/main/host-events.md), [deployment](https://github.com/privacykey/docs-mantis/blob/main/deployment/README.md), [updating](https://github.com/privacykey/docs-mantis/blob/main/updating.md)

## Contributing

The repo is a pnpm workspace and pnpm is the only supported package manager — the version is pinned in `packageManager` and CI reads it from there. Node comes from [`.nvmrc`](./.nvmrc).

```bash
pnpm install --frozen-lockfile
pnpm run check   # typecheck: server + CLI + edge + iot-helper
pnpm test        # unit tests
pnpm run build   # next build
```

CI also runs the integration and tier-2 suites against a real Postgres, builds the CLI, and audits production dependencies. [`CONTRIBUTING.md`](./CONTRIBUTING.md) has local setup and how to reproduce each job.

## Licence

MIT. See [`LICENSE`](./LICENSE).
