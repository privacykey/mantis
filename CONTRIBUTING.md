# Contributing

## Package manager

This repo is a pnpm workspace ([`pnpm-workspace.yaml`](./pnpm-workspace.yaml)).
pnpm is the only supported package manager — the exact version is pinned in
`packageManager` in [`package.json`](./package.json), and CI installs pnpm from
that field rather than a hard-coded version. Node comes from
[`.nvmrc`](./.nvmrc).

## Run from source

For contributors hacking on the web dashboard / server:

```bash
pnpm install
cp .env.example .env          # set DATABASE_URL and generate MANTIS_API_KEY_PEPPER
pnpm run db:migrate
pnpm dev
```

Generate the pepper with `openssl rand -base64 32` and add it as
`MANTIS_API_KEY_PEPPER` in `.env`.

Optional: `pnpm run setup:hooks` installs the repo's pre-commit hook
([`scripts/install-hooks.sh`](./scripts/install-hooks.sh)).

## What CI runs

Everything below is taken from
[`.github/workflows/ci.yml`](./.github/workflows/ci.yml), which runs on pushes
to `main`, on pull requests, and on manual dispatch. Each job starts with
`pnpm install --frozen-lockfile`.

| Job | Command |
| --- | --- |
| typecheck (server + cli + edge) | `pnpm run check` |
| unit + integration tests | `pnpm run db:migrate`, `pnpm test`, `pnpm run test:integration`, `pnpm run test:tier2` |
| next build | `pnpm run build` |
| CLI build artifact | `pnpm --filter @mantis/cli run build`, then `node cli/dist/index.js --version` |
| dependency audit | `pnpm audit --prod --audit-level=high` |

Notes on the test tiers:

- `pnpm test` — Vitest unit suite ([`vitest.config.ts`](./vitest.config.ts)).
- `pnpm run test:integration` — full-stack tests that exercise the real route
  handlers against a live Postgres
  ([`vitest.integration.config.ts`](./vitest.integration.config.ts)). The
  suite's `globalSetup` re-applies migrations idempotently. Locally,
  `pnpm run test:integration:db` starts a database for you via
  [`scripts/test-integration.sh`](./scripts/test-integration.sh).
- `pnpm run test:tier2` — end-to-end against a production `next build` and the
  standalone server entrypoint over real HTTP
  ([`vitest.tier2.config.ts`](./vitest.tier2.config.ts),
  [`scripts/test-tier2.sh`](./scripts/test-tier2.sh)). It covers the two things
  handler-level tests cannot see: the proxy host-split as applied by the runtime
  matcher, and the wire-level `Set-Cookie` `Secure` attribute. Set
  `MANTIS_TIER2_USE_EXISTING_DB=1` to reuse a database you already have running.

The audit job fails the build on a high or critical advisory in production
dependencies. `pnpm-workspace.yaml` carries overrides that patch known
transitive CVEs; moderate advisories are tracked by Dependabot rather than
blocking.

## Benchmarks

```bash
pnpm run bench       # CLI only
pnpm run bench:all   # CLI + edge + server
```

See [`bench/README.md`](./bench/README.md) for what each harness measures and
the recorded baselines.

## Versioning

The server, the CLI, the edge worker and the LAN helper are versioned
independently and each has its own `package.json` version. CLI releases are cut
by [`.github/workflows/cli-release.yml`](./.github/workflows/cli-release.yml),
which also regenerates the Homebrew formula in `privacykey/homebrew-tap`.
