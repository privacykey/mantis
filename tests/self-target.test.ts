import { afterEach, describe, expect, it, vi } from "vitest";

// A webhook-shaped destination aimed at this instance's own trigger URL makes
// every delivery a fresh hit that fans out again. isSelfTarget() is the guard
// applied when a destination is saved (validateDestination) and again when it
// is sent (safePostJson).

const VARS = [
  "PUBLIC_BASE_URL",
  "DASHBOARD_BASE_URL",
  "PUBLIC_ONLY_HOSTS",
  "DASHBOARD_HOSTS",
  "MANTIS_PUBLIC_PATH",
  "PORT",
] as const;
const original = Object.fromEntries(VARS.map((name) => [name, process.env[name]]));

/** Loads the guard under a given deployment config (env.ts reads at import). */
async function load(config: Partial<Record<(typeof VARS)[number], string>>) {
  for (const name of VARS) delete process.env[name];
  Object.assign(process.env, config);
  vi.resetModules();
  const [{ isSelfTarget, SELF_DESTINATION }, { validateDestination }] = await Promise.all([
    import("@/lib/notify/self-target"),
    import("@/lib/notify/channels"),
  ]);
  return { isSelfTarget, SELF_DESTINATION, validateDestination };
}

afterEach(() => {
  for (const name of VARS) {
    if (original[name] === undefined) delete process.env[name];
    else process.env[name] = original[name];
  }
});

describe("isSelfTarget", () => {
  it("matches the public trigger origin, whatever the path, case or scheme", async () => {
    const { isSelfTarget } = await load({ PUBLIC_BASE_URL: "https://canary.example.com" });
    for (const target of [
      "https://canary.example.com/c/AbCdEf1234",
      "https://canary.example.com/c/AbCdEf1234?n=7",
      "https://CANARY.example.com./c/AbCdEf1234",
      "https://canary.example.com:443/track/AbCdEf1234",
      "http://canary.example.com/c/AbCdEf1234", // the same front end on port 80
      "https://user:pw@canary.example.com/c/AbCdEf1234",
      "https://canary.example.com/api/webhook/abc",
    ]) {
      expect(isSelfTarget(target), target).toBe(true);
    }
  });

  it("leaves other hosts, and other services on the same host, alone", async () => {
    const { isSelfTarget } = await load({ PUBLIC_BASE_URL: "http://nas.lan:3000" });
    for (const target of [
      "https://hooks.example.org/mantis",
      "https://canary.example.com.evil.test/c/AbCdEf1234",
      "http://nas.lan:8123/api/webhook/abc", // Home Assistant next to Mantis
      "http://nas.lan/hook",
      "not a url",
      "ftp://nas.lan:3000/x",
    ]) {
      expect(isSelfTarget(target), target).toBe(false);
    }
    expect(isSelfTarget("http://nas.lan:3000/c/AbCdEf1234")).toBe(true);
  });

  it("covers the dashboard origin and every host-split name", async () => {
    const { isSelfTarget } = await load({
      PUBLIC_BASE_URL: "https://mantis-public.tailnet.ts.net",
      PUBLIC_ONLY_HOSTS: "mantis-public.tailnet.ts.net, alias.example.org",
      DASHBOARD_HOSTS: "mantis-private.tailnet.ts.net",
    });
    expect(isSelfTarget("https://mantis-public.tailnet.ts.net/c/AbCdEf1234")).toBe(true);
    expect(isSelfTarget("https://alias.example.org/c/AbCdEf1234")).toBe(true);
    expect(isSelfTarget("https://mantis-private.tailnet.ts.net/api/keys")).toBe(true);
    expect(isSelfTarget("https://other.tailnet.ts.net/hook")).toBe(false);

    const explicit = await load({
      PUBLIC_BASE_URL: "https://canary.example.com",
      DASHBOARD_BASE_URL: "https://admin.example.com:8443",
    });
    expect(explicit.isSelfTarget("https://admin.example.com:8443/login")).toBe(true);
    expect(explicit.isSelfTarget("https://admin.example.com/login")).toBe(false);
  });

  it("treats loopback on its own port as itself under any spelling", async () => {
    const { isSelfTarget } = await load({ PUBLIC_BASE_URL: "https://canary.example.com" });
    for (const host of ["localhost", "127.0.0.1", "127.8.9.10", "[::1]", "[::ffff:127.0.0.1]", "0.0.0.0", "app.localhost"]) {
      expect(isSelfTarget(`http://${host}:3000/c/AbCdEf1234`), host).toBe(true);
    }
    // Some other local service: allowed (ALLOW_PRIVATE_WEBHOOKS decides).
    expect(isSelfTarget("http://127.0.0.1:8080/hook")).toBe(false);

    const custom = await load({ PUBLIC_BASE_URL: "https://canary.example.com", PORT: "8080" });
    expect(custom.isSelfTarget("http://127.0.0.1:8080/c/AbCdEf1234")).toBe(true);
    expect(custom.isSelfTarget("http://127.0.0.1:3000/hook")).toBe(false);
  });

  it("allows the built-in dev inbox, the one receiver that lives on its own origin", async () => {
    // docs/GETTING-STARTED.md: mantis new "first mantis" -w http://localhost:3000/inbox/demo
    const { isSelfTarget } = await load({ PUBLIC_BASE_URL: "http://localhost:3000" });
    expect(isSelfTarget("http://localhost:3000/inbox/demo")).toBe(false);
    expect(isSelfTarget("http://localhost:3000/c/AbCdEf1234")).toBe(true);
    expect(isSelfTarget("http://localhost:3000/inbox")).toBe(true);
    // Dot segments cannot smuggle the trigger path through the exemption.
    expect(isSelfTarget("http://localhost:3000/inbox/../c/AbCdEf1234")).toBe(true);
  });

  it("does not exempt /inbox when the trigger prefix lives there", async () => {
    const moved = await load({ PUBLIC_BASE_URL: "http://localhost:3000", MANTIS_PUBLIC_PATH: "/inbox" });
    expect(moved.isSelfTarget("http://localhost:3000/inbox/AbCdEf1234")).toBe(true);

    const nested = await load({ PUBLIC_BASE_URL: "http://localhost:3000", MANTIS_PUBLIC_PATH: "/inbox/t" });
    expect(nested.isSelfTarget("http://localhost:3000/inbox/t/AbCdEf1234")).toBe(true);
    expect(nested.isSelfTarget("http://localhost:3000/inbox/demo")).toBe(false);
  });
});

describe("validateDestination refuses self-targets when a destination is saved", () => {
  it("rejects a webhook or Home Assistant URL on this instance", async () => {
    const { validateDestination, SELF_DESTINATION } = await load({
      PUBLIC_BASE_URL: "https://canary.example.com",
    });
    expect(validateDestination("webhook", "https://canary.example.com/c/AbCdEf1234")).toEqual({
      ok: false,
      error: SELF_DESTINATION,
    });
    expect(
      validateDestination("home_assistant", "https://canary.example.com/api/webhook/abc"),
    ).toEqual({ ok: false, error: SELF_DESTINATION });
    expect(validateDestination("webhook", "https://hooks.example.org/mantis")).toEqual({ ok: true });
  });
});
