# mantis server/container benchmarks

HTTP benchmarks for a running main Mantis server or Docker container. These are
intended for local release checks and regression investigations, not CI.

## Running Against Docker

Start Mantis normally, grab the bootstrap/API key, then run:

```bash
MANTIS_BENCH_KEY=mantis_live_... npm run bench:server
```

If the server is not on `http://127.0.0.1:3000`:

```bash
MANTIS_BENCH_URL=https://mantis-private.example.ts.net \
MANTIS_BENCH_KEY=mantis_live_... \
npm run bench:server
```

For split deployments, `--url` / `MANTIS_BENCH_URL` should usually be the
private dashboard/API host. If generated trigger URLs point somewhere else and
you want to benchmark a specific public origin, pass:

```bash
node bench/server/bench.js --all \
  --url=https://mantis-private.example.ts.net \
  --trigger-base-url=https://mantis-public.example.ts.net \
  --key=mantis_live_...
```

The default `--all` run creates one temporary key with `response_kind=empty`,
seeds a few hits, benchmarks the hot paths, and deletes the key afterward.

## Scenarios

| Scenario | What it measures |
|---|---|
| `health` | `/api/health` liveness/readiness path |
| `api-list` | Authenticated `GET /api/keys?limit=50` |
| `trigger-hit` | Public trigger recording path with empty response |
| `recent-hits` | Cross-key recent hit feed used by `mantis watch` |
| `key-hits` | Per-key hit history path |

## Budgets

`--assert` uses loose local p99 budgets:

| Scenario | p99 target |
|---|---:|
| `health` | < 150 ms |
| `api-list` | < 250 ms |
| `trigger-hit` | < 350 ms |
| `recent-hits` | < 300 ms |
| `key-hits` | < 300 ms |

Append release numbers with:

```bash
MANTIS_BENCH_KEY=mantis_live_... node bench/server/bench.js --all --write-baseline
```
