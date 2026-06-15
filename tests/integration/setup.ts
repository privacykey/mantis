// Per-file setup for the integration suite. Runs before each test file's
// imports, so anything that reads process.env at import time (env.ts) sees
// these values.

// A real, migrated Postgres is mandatory here — these tests assert SQL
// behavior. Fail loudly rather than silently passing against the unit-suite
// dummy DSN (set in tests/setup.ts).
const url = process.env.DATABASE_URL;
if (!url || url.includes("@localhost/test")) {
  throw new Error(
    "Integration tests require a real DATABASE_URL pointing at a migrated " +
      "test Postgres. Run `pnpm test:integration:db`, or set DATABASE_URL " +
      "(e.g. postgres://mantis:mantis@localhost:5433/mantis_test) and run " +
      "`pnpm test:integration`.",
  );
}

process.env.MANTIS_API_KEY_PEPPER ??= "integration-pepper-not-secret";
process.env.PUBLIC_BASE_URL ??= "http://localhost:3000";
