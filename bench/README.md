# mantis benchmarks

Performance benchmark suite. **Not run on CI** — run locally before publishing
performance claims or chasing a regression.

| Tier   | Status      | Where                  |
| ------ | ----------- | ---------------------- |
| edge   | ✅ implemented | [`edge/`](./edge/)      |
| server | ✅ implemented | [`server/`](./server/)  |
| cli    | ✅ implemented | [`cli/`](./cli/)        |

Each tier has its own README with setup, scenarios, and aspirational SLOs.

## Why no CI integration

Bench runs are slow (minutes) and noisy on shared CI runners (CPU-shared, network-shared).
The tradeoff isn't worth it for now: run locally before a release or when
investigating a regression, commit the resulting numbers to the tier's
`baseline.md`, and diff in code review.

## Quick Commands

This repo is a pnpm workspace, so run the bench scripts with `pnpm` — they're
defined in the root `package.json` and shell out to `pnpm --filter ...` for the
per-tier workspaces.

```bash
# CLI overhead; uses a local mock API
pnpm run bench:cli

# Cloudflare Worker edge benchmark; requires `npx wrangler dev` running
pnpm run bench:edge

# Main server/container benchmark; requires a running server and API key
MANTIS_BENCH_KEY=mantis_live_... pnpm run bench:server

# Run every tier after setting up the edge worker and main server
MANTIS_BENCH_KEY=mantis_live_... pnpm run bench:all
```
