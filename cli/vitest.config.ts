import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
  resolve: {
    alias: {
      // Map @mantis/core to its source so tests don't require a built dist.
      // Subpath entries must precede the bare entry — aliases match in order.
      "@mantis/core/installers": resolve(
        here,
        "../packages/core/src/installers.ts",
      ),
      "@mantis/core/device-profiles": resolve(
        here,
        "../packages/core/src/device-profiles.ts",
      ),
      "@mantis/core/device-bundle": resolve(
        here,
        "../packages/core/src/device-bundle.ts",
      ),
      "@mantis/core": resolve(here, "../packages/core/src/index.ts"),
    },
  },
});
