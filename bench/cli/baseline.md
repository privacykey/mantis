# mantis CLI bench baselines

Numbers from `node bench/cli/bench.js --all --write-baseline`. Each section is
one run. Append-only: review the diff to spot regressions.

The API-backed scenarios use a local in-process mock server. These numbers are
for CLI overhead, not real server latency.

Loose local budgets used by `--assert`:

| Scenario | p95 target |
|---|---:|
| `version` | < 500 ms |
| `help` | < 650 ms |
| `list-json` | < 800 ms |
| `list-table` | < 850 ms |
| `show-json` | < 800 ms |
| `hits-json` | < 850 ms |
| `doctor` | < 1000 ms |

<!-- new runs appended below -->
