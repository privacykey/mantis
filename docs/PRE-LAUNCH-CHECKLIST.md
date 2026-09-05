# Pre-launch checklist

Scope: server/dashboard, CLI, and edge worker. Review started 2026-09-05 from
`42175e3e2ec8584ee5092a138dee406f15dd3b7f` on main. Checks below distinguish local
verification from deployment-specific sign-off; a green build alone is not a
production launch check.

## Repository checks

- [x] Review open PRs and issues. No open issues; PR #84 fixes polling intervals
  and PR #81 updates the CLI quick reference. Both have green CI.
- [x] Check production dependencies: fresh `pnpm audit --prod` reports zero
  advisories; GitHub reports no open Dependabot alerts.
- [x] Run all component unit tests: **284 server + 117 CLI + 64 edge = 465**
  passing after the fixes, via `pnpm run test:all`.
- [x] Make CLI tests reliable from a fresh checkout: regenerate the version
  before testing and isolate terminal/locale settings in output tests.
- [x] Include server, CLI, and edge tests in CI, plus an edge packaging dry run.
- [x] Reject malformed IDs (400), malformed JSON (400), and oversized bodies
  (413) on bulk/device downloads; accept valid uppercase UUIDs.
- [x] Preserve first-format attribution on bulk downloads.
- [x] Verify edge request handling, expiration, and webhook allowlists. A
  configured allowlist with no valid rules now blocks forwarding.
- [x] Run **91 integration tests** against an isolated Postgres database.
- [x] Run **11 production HTTP tests** for host separation, secure session
  cookies, custom trigger URLs, and the HTML response sandbox.
- [x] Route the documented `MANTIS_PUBLIC_PATH` URLs to the trigger handler;
  normalize trailing slashes consistently when generating URLs.
- [x] Pass `pnpm run check`, CLI/Next builds, and an edge deployment dry run.
- [x] Build the actual Docker image, start it with automatic migrations and a
  separate test database, and verify Docker reports `healthy`. Fix the health
  probe to use the configured dashboard hostname; public management requests
  still return 404.
- [x] Smoke-test the macOS arm64 native CLI (`--version` and `--help`). Confirm
  the existing release has all four platform tarballs and `SHA256SUMS`. Add
  native smoke tests to the release workflow for each target before packaging.

Local validation covers **567 passing tests** across unit, integration, and
production HTTP suites. The polling regression tests in PR #84 are separate;
that PR still needs to be merged. The checks here use test databases and local
notification sinks, not production credentials or real alert destinations.

## Release and deployment sign-off

- [ ] Merge reviewed fixes, including PR #84, and verify CI on the release commit.
- [ ] Select component versions and release only the reviewed commit. The current
  CLI release is `cli-v0.2.0`; changes after that tag require a new release.
- [ ] Verify the actual public URL, HTTPS termination, dashboard/public host
  separation, trusted proxy headers, and secure cookies in the target deployment.
- [ ] Confirm production secrets, database backups, and a tested restore procedure.
  Preserve the API-key pepper and edge encryption key across redeploys.
- [ ] Trigger a dedicated canary and verify delivery to each enabled real
  notification destination; verify retries and monitoring of delivery failures.
- [ ] Confirm notification worker or cron operation, retention policy, health
  monitoring, and rollback instructions for the selected host.
- [ ] For Apple Wallet, verify mounted signing/APNs assets and a real-device pass
  lifecycle if that optional feature is enabled.
- [ ] Verify CLI release binaries on each supported OS/architecture and the
  Homebrew install/upgrade path; a local native smoke test covers only this host.
- [ ] Deploy an edge test worker, configure its encryption key and webhook
  allowlist, then verify an encrypted URL against a real destination.
