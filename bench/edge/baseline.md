# mantis-edge bench baselines

Numbers from `node bench.js --all --write-baseline`. Each section is one run.
Append-only — every new run adds a section; review the diff to spot regressions.

Aspirational SLOs (these are deployed-CF targets; local wrangler-dev numbers
will be different — generally tighter on a fast laptop, looser when comparing
to the CF colo p99):

| Metric                                    | Target           |
| ----------------------------------------- | ---------------- |
| Steady-state p50 (single CF region)       | < 5 ms           |
| Steady-state p99 (single CF region)       | < 25 ms          |
| Sustained throughput per isolate          | ≥ 5 000 req/s    |
| Cold-start added latency                  | < 20 ms          |
| 404 path latency relative to happy path   | within ±10%      |
| Δ p99 (heavy vs minimal URL)              | within ±25%      |
| Live-webhook overhead vs black-hole       | within ±15% p99  |

<!-- new runs appended below -->

## 2026-05-13T04:03:24.720Z

host: `darwin-arm64` · node `v24.15.0`

### cold-start

| metric | value |
|---|---|
| requests | 1 |
| duration | 1.01 s |
| throughput | 1 req/s |
| p50 | 2 ms |
| p95 | 2 ms |
| p99 | 2 ms |
| max | 2 ms |
| non-2xx | 0 |
| url length | 118 chars |
| note | single-request sample; rerun for a distribution |

### steady-state

| metric | value |
|---|---|
| requests | 6331 |
| duration | 6.01 s |
| throughput | 1055.17 req/s |
| p50 | 6 ms |
| p95 | 32 ms |
| p99 | 51 ms |
| max | 137 ms |
| non-2xx | 0 |
| url length | 118 chars |
| target | http://127.0.0.1:8787/c/AT7HbxfBXsXbVf-9F_BzVDH7c_mGnzoXd5HlODYu7qcGWnONd_40QZewuYDHv0wKyTUe0Lt8_SoIL6WDiI3dhnh0R09lgg |

### throughput-ceiling

| metric | value |
|---|---|
| requests | 12937 |
| duration | 8.01 s |
| throughput | 1617.13 req/s |
| p50 | 26 ms |
| p95 | 66 ms |
| p99 | 79 ms |
| max | 180 ms |
| non-2xx | 0 |
| best concurrency (p99 ≤ 100ms) | 50 |
|   @  10 | 1765.75 rps · p50 4ms · p99 22ms · err 0 |
|   @  50 | 1617.13 rps · p50 26ms · p99 79ms · err 0 |
|   @ 100 | 1720.63 rps · p50 50ms · p99 168ms · err 0 |
|   @ 200 | 2017.63 rps · p50 86ms · p99 195ms · err 0 |
|   @ 400 | 1968.75 rps · p50 179ms · p99 414ms · err 0 |

### blob-length

| metric | value |
|---|---|
| requests | 11345 |
| duration | 6 s |
| throughput | 1890.84 req/s |
| p50 | 4 ms |
| p95 | 16 ms |
| p99 | 19 ms |
| max | 80 ms |
| non-2xx | 0 |
| minimal URL chars | 116 |
| minimal p50/p99/rps | 4 ms · 21 ms · 1978 rps |
| heavy URL chars   | 430 |
| heavy p50/p99/rps   | 4 ms · 19 ms · 1890.84 rps |
| Δ p99 | -10 % |

### webhook-forward

| metric | value |
|---|---|
| requests | 10788 |
| duration | 6 s |
| throughput | 1798 req/s |
| p50 | 4 ms |
| p95 | 16 ms |
| p99 | 20 ms |
| max | 201 ms |
| non-2xx | 0 |
| black-hole p50/p99/rps | 4 ms · 21 ms · 2013.5 rps |
| live       p50/p99/rps | 4 ms · 20 ms · 1798 rps |
| Δ p99 (live vs black-hole) | -5 % |
| webhooks received | 10796 (6164516 bytes) |
| webhooks lost | 0 |

### scan-404

| metric | value |
|---|---|
| requests | 23138 |
| duration | 6.01 s |
| throughput | 3856.67 req/s |
| p50 | 1 ms |
| p95 | 12 ms |
| p99 | 16 ms |
| max | 38 ms |
| non-2xx | 0 |
| expected | all 404 |
| non-2xx (good) | 23138 |
| socket errors (bad) | 0 |
| pool size | 64 |
