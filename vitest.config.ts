import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
    // Full-stack DB integration tests live under tests/integration and run via
    // vitest.integration.config.ts against a real Postgres — keep them out of
    // the fast, mock-only unit run.
    exclude: [
      "node_modules",
      ".next",
      "dist",
      "cli",
      "mantis-edge",
      "tests/integration/**",
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
    },
  },
});
