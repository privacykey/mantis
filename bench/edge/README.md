# mantis-edge benchmarks

Load tests for the Cloudflare Worker variant of mantis. Built on
[autocannon](https://github.com/mcollina/autocannon).

## Setup (one time)

```bash
cd bench/edge && npm install
```

## Running

The bench needs **a running worker** and **the AES key it was launched with**:

```bash
# Terminal 1 — run the worker
cd mantis-edge
# (one time) seed a key
echo "MANTIS_EDGE_KEY=$(node -e 'console.log(require("crypto").randomBytes(32).toString("base64url"))')" > .dev.vars
npx wrangler dev   # listens on 127.0.0.1:8787

# Terminal 2 — run the bench
cd bench/edge
node bench.js --scenario=steady-state
```

The bench auto-loads `MANTIS_EDGE_KEY` from `mantis-edge/.dev.vars`, or you can export
it: `MANTIS_EDGE_KEY=… node bench.js --scenario=…`.

## Scenarios

| Scenario              | What it measures                                                | Default duration |
| --------------------- | --------------------------------------------------------------- | ---------------- |
| `cold-start`          | One-shot single request; isolate-warm sample                    | ~1 s             |
| `steady-state`        | Primary p99 — fixed concurrency, valid sealed URL               | 30 s             |
| `throughput-ceiling`  | Ramps connections 10 → 400; reports the highest with p99 ≤ 100ms| 8 s × 5 steps    |
| `blob-length`         | Minimal vs heavy payload; Δ p99 should be < 25 %                | 30 s × 2         |
| `webhook-forward`     | Black-hole vs live receiver; `ctx.waitUntil` shouldn't block    | 30 s × 2         |
| `scan-404`            | Rotating invalid blobs; reject path shouldn't be slower         | 30 s             |

All scenarios accept:

```
--worker=<url>          default http://127.0.0.1:8787 (env: MANTIS_EDGE_BENCH_WORKER)
--duration=<seconds>    default 30
--connections=<n>       default 10
--pipelining=<n>        default 1
--write-baseline        append the result to baseline.md
```

Run everything and commit the numbers:

```bash
node bench.js --all --write-baseline
```

## Interpreting results

`baseline.md` lists the **aspirational SLOs** at the top. Wrangler-dev is a local
process; absolute throughput won't match deployed CF, but the *shape* (cold vs
warm, heavy vs minimal, 404 vs hit) is the same. Use the deltas in
`blob-length`, `webhook-forward`, and `scan-404` as the regression signals.

## Known caveats

- `cold-start` is an isolate-warm sample (wrangler keeps the isolate alive
  during the run). True cold-start measurement requires deploying + waiting
  out an idle window; not automated here.
- autocannon doesn't natively expose p95; we fall back to p97.5 or p99.
- The `scan-404` pool size is 64 — autocannon cycles through them, so high
  RPS will repeat URLs. The worker decode path stays identical regardless.
