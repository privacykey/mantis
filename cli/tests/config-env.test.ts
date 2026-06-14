import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// resolveAuth reads XDG_CONFIG_HOME at module load to locate the config file.
// Point it at an empty temp dir (set before the first dynamic import below) so
// these tests never see a real user config and exercise only the env path.
describe("resolveAuth env-var credentials", () => {
  const saved = { ...process.env };

  beforeEach(() => {
    process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "mantis-cfg-"));
    delete process.env.MANTIS_PROFILE;
    delete process.env.MANTIS_BASE_URL;
    delete process.env.MANTIS_API_KEY;
  });

  afterEach(() => {
    process.env = { ...saved };
  });

  it("uses MANTIS_BASE_URL + MANTIS_API_KEY when no profile is configured", async () => {
    process.env.MANTIS_BASE_URL = "https://ci.example.com/";
    process.env.MANTIS_API_KEY = "mantis_live_ci";
    const { resolveAuth } = await import("../src/lib/config.js");
    const auth = await resolveAuth({});
    expect(auth.baseUrl).toBe("https://ci.example.com"); // trailing slash stripped
    expect(auth.key).toBe("mantis_live_ci");
    expect(auth.profile).toBeUndefined();
  });

  it("prefers explicit --base-url / --key over the env vars", async () => {
    process.env.MANTIS_BASE_URL = "https://env.example.com";
    process.env.MANTIS_API_KEY = "env-key";
    const { resolveAuth } = await import("../src/lib/config.js");
    const auth = await resolveAuth({
      baseUrl: "https://flag.example.com",
      key: "flag-key",
    });
    expect(auth.baseUrl).toBe("https://flag.example.com");
    expect(auth.key).toBe("flag-key");
  });

  it("errors on an explicitly named missing profile even if MANTIS_BASE_URL is set", async () => {
    process.env.MANTIS_BASE_URL = "https://env.example.com";
    process.env.MANTIS_API_KEY = "env-key";
    const { resolveAuth } = await import("../src/lib/config.js");
    await expect(resolveAuth({ profile: "ghost" })).rejects.toThrow(/not found/);
  });
});
