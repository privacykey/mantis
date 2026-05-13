# mantis server/container bench baselines

Numbers from `node bench/server/bench.js --all --write-baseline`. Each section
is one run. Append-only: review the diff to spot regressions.

Loose local budgets used by `--assert`:

| Scenario | p99 target |
|---|---:|
| `health` | < 150 ms |
| `api-list` | < 250 ms |
| `trigger-hit` | < 350 ms |
| `recent-hits` | < 300 ms |
| `key-hits` | < 300 ms |

<!-- new runs appended below -->
