// Per-file setup for the Tier-2 suite. These tests drive a BUILT, RUNNING
// standalone server over real HTTP, and seed its database directly — both
// processes must therefore agree on DATABASE_URL and MANTIS_API_KEY_PEPPER
// (scripts/test-tier2.sh exports the same values to each).

export {}; // module scope, so `url` can't collide with tests/integration/setup.ts

const url = process.env.DATABASE_URL;
if (!url || url.includes("@localhost/test")) {
  throw new Error(
    "Tier-2 tests require a real DATABASE_URL — the SAME database the server " +
      "under test is connected to. Run `pnpm test:tier2` " +
      "(scripts/test-tier2.sh) rather than invoking vitest directly.",
  );
}

if (!process.env.MANTIS_TIER2_BASE_URL) {
  throw new Error(
    "MANTIS_TIER2_BASE_URL is not set — Tier-2 tests need a running " +
      "production build (`node .next/standalone/server.js`). Run " +
      "`pnpm test:tier2`, or start the server yourself and export " +
      "MANTIS_TIER2_BASE_URL (plus matching PUBLIC_ONLY_HOSTS / " +
      "DASHBOARD_HOSTS / MANTIS_API_KEY_PEPPER).",
  );
}

process.env.MANTIS_API_KEY_PEPPER ??= "integration-pepper-not-secret";
process.env.PUBLIC_BASE_URL ??= "http://localhost:3000";
