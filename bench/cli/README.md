# mantis CLI benchmarks

Local latency benchmarks for the `mantis` command itself. These are not API
load tests: API-backed scenarios use an in-process mock server so the signal is
CLI startup, argument parsing, request plumbing, rendering, and JSON/table
output cost.

## Running

From the repo root:

```bash
npm run bench:cli
```

Or run one scenario:

```bash
npm --prefix cli run build
node bench/cli/bench.js --scenario=list-json --iterations=50
```

## Scenarios

| Scenario | What it measures |
|---|---|
| `version` | Cold-ish process startup and Commander version path |
| `help` | Full help generation |
| `list-json` | Authenticated list command with JSON output |
| `list-table` | Authenticated list command with table rendering |
| `show-json` | Single-key fetch and JSON output |
| `hits-json` | Hit listing and JSON output |
| `doctor` | Health/auth doctor path against the mock server |

## Budgets

`--assert` checks intentionally loose local budgets. They are meant to catch
large regressions, not small laptop-to-laptop noise.

```bash
node bench/cli/bench.js --all --assert
```

Append release numbers with:

```bash
node bench/cli/bench.js --all --write-baseline
```
