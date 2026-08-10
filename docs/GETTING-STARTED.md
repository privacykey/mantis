# Getting started

Moved out of the top-level README so it stays short. Everything here was in the
README before; nothing has been added.

**Stateful server or stateless edge?** Run the full **server** (`docker compose`,
Postgres-backed) when you want the web dashboard, notification queue,
file/host-event keys, and history. Run the **edge**
([`mantis-edge/`](../mantis-edge/README.md)) — a Cloudflare Worker that decrypts
URLs at the edge with no DB to host — when you only need fire-and-forget hit
alerts and want zero infrastructure.

The fastest path either way is the guided CLI: `mantis init` asks server-or-edge
and walks you through login and your first key.

```bash
brew install privacykey/tap/mantis
mantis init
```

## Quickstart (stateful server)

```bash
git clone https://github.com/privacykey/mantis && cd mantis
./scripts/setup.sh   # creates .env with a random DB password + API-key pepper
docker compose up -d
# Wait for the boot banner, then read the one-time bootstrap admin key
docker compose logs -f mantis | grep -m1 -A1 "bootstrap API key"
```

`setup.sh` is idempotent — re-running it leaves existing secrets untouched.
Postgres is never published to the host (it sits on an internal-only docker
network), and the DB password is the single value you set in `.env`; the app's
`DATABASE_URL` is derived from it.

The `mantis_live_...` value printed above is the **bootstrap admin key** — it is
both your CLI token and your dashboard login. To know it up front instead,
pre-set `BOOTSTRAP_API_KEY=mantis_live_...` in `.env` before the first boot.

Open <http://localhost:3000> and paste that same key to sign in to the web
dashboard. Then log in the CLI and mint a key:

```bash
mantis --key mantis_live_... login --url http://localhost:3000
mantis new "first mantis" -w http://localhost:3000/inbox/demo
```

This is fine for evaluation but **don't rely on a laptop deploy for canaries
that need to fire when you're away from your machine.** For a real
public-reachable deploy — Tailscale Funnel, Cloudflare Tunnel, Railway, Fly.io,
or Render — see
[deployment options](https://docs.mantis.privacykey.org/deployment).

> [!CAUTION]
> **Serve it over HTTPS, never plain HTTP.** Mantis authenticates with an API
> key sent as a bearer token and a session cookie — over plain HTTP on a
> routable address both travel in cleartext and can be sniffed. Put it behind a
> tunnel (the `tailscale` / `cloudflared` compose profiles terminate TLS for
> you) or a TLS reverse proxy. The compose setup keeps Postgres on an
> internal-only network with no published port, so the database is never
> reachable from the host or LAN.

### Fly.io in one command

One command provisions the app, a Managed Postgres cluster, the secrets and the
first admin key:

```bash
bash deploy/fly-launch.sh --app my-mantis --region iad
```

Add `--dry-run` to see every command it would run first. See
[`deploy/fly.toml.example`](../deploy/fly.toml.example) for the config it
generates, and
[`.github/workflows/fly-deploy.yml`](../.github/workflows/fly-deploy.yml) to
make later pushes deploy themselves.

## Quickstart (no server / edge)

No DB to host: deploy the Cloudflare Worker, then mint URLs that decrypt at the
edge.

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

See [`mantis-edge/README.md`](../mantis-edge/README.md) for Worker deploy and
full `mantis edge` usage.

## Components

Each part of the repo has its own reference:

- **CLI** — [`cli/README.md`](../cli/README.md) (full reference) and
  [`cli/COMMAND_MAP.md`](../cli/COMMAND_MAP.md) (command map)
- **Edge worker** — [`mantis-edge/README.md`](../mantis-edge/README.md)
- **IoT / LAN helper** — [`iot-helper/README.md`](../iot-helper/README.md)
- **Benchmarks** — [`bench/README.md`](../bench/README.md)
- **Deploy assets** — [`deploy/`](../deploy/) (one-command Fly.io launch, Render
  example)
- **MDM fleet canaries** — [`deploy/kandji/`](../deploy/kandji/README.md) (one
  key per managed Mac, terminal-open alerts)
