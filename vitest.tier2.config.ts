import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

// Tier-2 end-to-end tests: a real `next build` served by the standalone
// production entrypoint (`node .next/standalone/server.js` — the same thing
// docker/Dockerfile runs), exercised over real HTTP. This is the only tier
// that can observe behavior the RUNTIME applies: the proxy host-split matcher
// and the wire-level Set-Cookie attributes. Everything else belongs in the
// cheaper handler-level integration suite (vitest.integration.config.ts).
//
// Run the one-shot pipeline (docker PG → migrate → build → serve → test):
//   pnpm test:tier2
export default defineConfig({
  test: {
    include: ["tests/tier2/**/*.test.ts"],
    environment: "node",
    setupFiles: ["./tests/tier2/setup.ts"],
    // Same idempotent migration pass the integration suite uses.
    globalSetup: ["./tests/integration/global-setup.ts"],
    // Files share one database (and _harness truncates between tests).
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
  resolve: {
    alias: {
      "@": resolve(here, "src"),
    },
  },
});
