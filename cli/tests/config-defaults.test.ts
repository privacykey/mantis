import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// config.ts reads XDG_CONFIG_HOME at module load — set it (to an empty temp
// dir) before the dynamic import below so the roundtrip touches a throwaway
// config file, not the developer's real one.
describe("CLI defaults (mantis config)", () => {
  const saved = { ...process.env };

  beforeEach(() => {
    process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "mantis-def-"));
  });

  afterEach(() => {
    process.env = { ...saved };
  });

  it("roundtrips and removes defaults", async () => {
    const { getDefaults, setDefaults } = await import("../src/lib/config.js");

    expect(await getDefaults()).toEqual({});

    await setDefaults({ output: "json" });
    expect(await getDefaults()).toEqual({ output: "json" });

    await setDefaults({ color: "never" });
    expect(await getDefaults()).toEqual({ output: "json", color: "never" });

    // undefined removes a key rather than storing it
    await setDefaults({ output: undefined });
    expect(await getDefaults()).toEqual({ color: "never" });
  });
});
