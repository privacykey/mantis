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
> **Beta — v0.1.0.** APIs, DB schema, and CLI flags may still change before v1.0. Pin a release tag for stability.

Self-hostable mantis key service. API-first.

You mint a unique URL; when something fetches it, you get notified through the destinations you configure. Useful for honeypot files on shared drives, fake credentials in `.env`s, SSH-login alarms on jump boxes, detecting site clones, or any "did someone touch the thing they shouldn't" tripwire.

Highlights:

- **File keys** in 10 formats (`.docx` / `.xlsx` / `.pptx` / `.pdf` / `.svg` / `.html` / `.md` / `.eml` / `.ics` / `.vcf`) plus a 9-file honey-directory `.zip`
- **Host-event installers** — shell, sudo, login, boot, wake, network — for macOS, Linux, and Windows, with parsed `X-Mantis-*` context including SSH client IP
- **Web canaries** — CSS-background + JS clone-detector — and NFC NDEF tag URLs
- **Smart-home triggers** via Home Assistant, Scrypted, and an optional LAN watcher
- **Direct notification destinations** — webhook, email, Slack, Discord, Teams — with a Postgres-backed retry queue and per-key dedup
- **Optional stateless variant** ([`mantis-edge/`](./mantis-edge/README.md)) — a Cloudflare Worker that decrypts URLs at the edge, no DB to host
- **Uptime Kuma integration** — per-key status URL flips on hit, watched by Kuma for 80+ notification channel fan-out

## Quickstart

```bash
git clone https://github.com/privacykey/mantis && cd mantis
docker compose up -d
docker compose logs mantis | grep "bootstrap API key" -A1
```

Then install the CLI and log in against your local instance:

```bash
brew install privacykey/tap/mantis
mantis --key mantis_live_... login --url http://localhost:3000
mantis new "first mantis" -w http://localhost:3000/inbox/demo
```

This is fine for evaluation but **don't rely on a laptop deploy for canaries that need to fire when you're away from your machine.** For a real public-reachable deploy — Tailscale Funnel, Cloudflare Tunnel, Railway, Fly.io, or Render — see **[deployment options](https://github.com/privacykey/mantis-docs/blob/main/deployment/README.md)**.

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
