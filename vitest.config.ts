import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
    // Full-stack DB integration tests live under tests/integration (real
    // Postgres, vitest.integration.config.ts) and tier-2 e2e tests under
    // tests/tier2 (running standalone server, vitest.tier2.config.ts) — keep
    // both out of the fast, mock-only unit run.
    exclude: [
      "node_modules",
      ".next",
      "dist",
      "cli",
      "mantis-edge",
      "tests/integration/**",
      "tests/tier2/**",
    ],
    environment: "node",
    setupFiles: ["./tests/setup.ts"],
    // No global DB. Anything touching @/db should be tested via the actions
    // they expose (and mocked accordingly) — these unit tests target pure /
    // pure-ish modules: ssrf, validators, channels, audit shape, crypto.
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
      "@mantis/core/device-bundle-files": resolve(
        here,
        "packages/core/src/device-bundle-files.ts",
      ),
      "@mantis/core/device-bundle": resolve(
        here,
        "packages/core/src/device-bundle.ts",
      ),
      "@mantis/core": resolve(here, "packages/core/src/index.ts"),
    },
  },
});
