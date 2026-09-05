# Pre-launch checklist

Scope: server/dashboard, CLI, and edge worker. Review started 2026-09-05; combined fixes verified after merging PRs #81, #84,
and #85. Patch targets: server 0.2.1, CLI 0.2.2, edge 0.1.5. Checks below
distinguish repository verification from deployment-specific sign-off; a green
build alone is not a production launch check.

## Repository checks

- [x] Review open PRs and issues. No open issues; PR #84 fixes polling intervals
  and PR #81 updates the CLI quick reference. Both are merged with green CI.
- [x] Check production dependencies: fresh `pnpm audit --prod` reports zero
  advisories; GitHub reports no open Dependabot alerts.
- [x] Run all component unit tests: **297 server + 146 CLI + 64 edge = 507**
  passing after the fixes, via `pnpm run test:all`.
- [x] Make CLI tests reliable from a fresh checkout: regenerate the version
  before testing and isolate terminal/locale settings in output tests.
- [x] Include server, CLI, and edge tests in CI, plus an edge packaging dry run.
- [x] Reject malformed IDs (400), malformed JSON (400), and oversized bodies
  (413) on bulk/device downloads; accept valid uppercase UUIDs.
- [x] Preserve first-format attribution on bulk downloads.
- [x] Verify edge request handling, expiration, and webhook allowlists. A
  configured allowlist with no valid rules now blocks forwarding.
- [x] Run **101 integration tests** against an isolated Postgres database.
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

The combined review covers **619 passing tests** across unit, integration, and
production HTTP suites, including the security audit and polling regressions.
[Combined CI run](https://github.com/privacykey/mantis/actions/runs/33974108047)
passed all checks before merging the final fixes.
The checks here use test databases and local notification sinks, not production
credentials or real alert destinations.

## Release and deployment sign-off

- [ ] Merge reviewed fixes, including PR #84, and verify CI on the release commit.
- [ ] Publish patches from the reviewed commit: server `0.2.1`, CLI `0.2.2`,
  and edge `0.1.5`. Previous releases are server `v0.2.0` and CLI `cli-v0.2.1`.
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
