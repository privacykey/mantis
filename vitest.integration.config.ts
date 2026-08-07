import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

// Full-stack integration tests: these import real Next.js route handlers /
// libraries and run them against a REAL Postgres (no @/db mock). They cover the
// SQL predicates, authorization boundaries, and security-fix regressions that
// the mock-only unit run (vitest.config.ts) cannot reach.
//
// Run with a migrated test database:
//   pnpm test:integration:db   # one-shot: start docker PG, migrate, run, stop
// or against your own DB:
//   DATABASE_URL=postgres://mantis:mantis@localhost:5433/mantis_test pnpm test:integration
export default defineConfig({
  test: {
    include: ["tests/integration/**/*.test.ts"],
    exclude: ["node_modules", ".next", "dist", "cli", "mantis-edge"],
    environment: "node",
    setupFiles: ["./tests/integration/setup.ts"],
    globalSetup: ["./tests/integration/global-setup.ts"],
    // The route handlers share the process-global @/db connection pool and the
    // in-memory rate-limit buckets, and each test file TRUNCATEs the tables it
    // uses. Running files one at a time keeps them from racing on the single
    // shared database. (Tests within a file still run sequentially by default.)
    fileParallelism: false,
    // Real network preflights (SSRF guard) + DB round-trips are slower than the
    // pure unit suite; give individual cases room.
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
  resolve: {
    alias: {
      "@": resolve(here, "src"),
      // Map @mantis/core to its source so tests don't require a built dist.
      // Subpath entries must precede the bare entry — aliases match in order.
      "@mantis/core/installers": resolve(here, "packages/core/src/installers.ts"),
      "@mantis/core/device-profiles": resolve(
        here,
        "packages/core/src/device-profiles.ts",
      ),
      "@mantis/core/device-bundle": resolve(
        here,
        "packages/core/src/device-bundle.ts",
      ),
      "@mantis/core": resolve(here, "packages/core/src/index.ts"),
    },
  },
});
