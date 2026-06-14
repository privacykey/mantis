import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Regression guard for the login-lockout DoS: the dashboard login server action
// must NOT consume its Postgres-backed rate-limit token before validating
// credentials, and must NOT enforce the limiter when there is no trusted client
// IP. Otherwise every attempt cluster-wide collapses into one shared
// `login:anonymous` bucket and an unauthenticated flood (>10 POSTs/min) locks
// the operator out of the dashboard — and the operator's own valid attempt also
// burns a token. The fix mirrors requireApiKey in src/lib/auth.ts (limiter only
// on failure) and the trigger path in src/app/c/[publicId]/route.ts (fail open
// when ip === null), keeping the cross-instance cap for real-IP deployments.

const mocks = vi.hoisted(() => ({
  // Rows returned by the api-key lookup. [] = invalid/revoked, [row] = valid.
  selectRows: [] as Array<{ id: string; name: string; hash: string }>,
  // Header values returned by next/headers headers().get(name).
  headers: {} as Record<string, string>,
  // Underlying db.execute used by the real consumeRateLimit UPSERT.
  execute: vi.fn(),
  audit: vi.fn(),
  setSessionCookie: vi.fn(),
  redirect: vi.fn(),
}));

// Mock the db client so consumeRateLimit + the login lookup run without Postgres.
vi.mock("@/db/client", () => ({
  db: {
    execute: mocks.execute,
    select: () => ({
      from: () => ({
        where: () => ({ limit: () => Promise.resolve(mocks.selectRows) }),
      }),
    }),
    update: () => ({
      set: () => ({ where: () => Promise.resolve(undefined) }),
    }),
  },
}));
vi.mock("next/headers", () => ({
  headers: async () => ({
    get: (n: string) => mocks.headers[n.toLowerCase()] ?? null,
  }),
}));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("@/lib/audit", () => ({ audit: mocks.audit }));
vi.mock("@/lib/session", () => ({ setSessionCookie: mocks.setSessionCookie }));
// Avoid spinning up the real pino-pretty transport for the limiter's fail-open
// log path (mirrors tests/rate-limit.test.ts).
vi.mock("@/lib/log", () => ({
  log: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { loginAction } from "@/app/login/actions";

const VALID_KEY = `mantis_live_${"a".repeat(24)}`;
const VALID_ROW = {
  id: "00000000-0000-0000-0000-000000000001",
  name: "operator",
  // Differs from the computed v2 hash so the opportunistic-upgrade branch is
  // also exercised (db.update mock resolves, .catch is a no-op).
  hash: "deadbeef",
};

function form(key: string): FormData {
  const fd = new FormData();
  fd.set("api_key", key);
  return fd;
}

beforeEach(() => {
  mocks.execute.mockReset();
  mocks.audit.mockReset();
  mocks.setSessionCookie.mockReset();
  mocks.redirect.mockReset();
  mocks.selectRows = [];
  mocks.headers = {};
});

afterEach(() => vi.unstubAllEnvs());

describe("login rate-limit lockout DoS", () => {
  it("no trusted IP: a flooded shared bucket cannot lock out valid credentials", async () => {
    // No trusted client IP (production default when TRUST_PROXY_HEADERS is unset
    // and not on Vercel) → loginClientIp() returns null.
    vi.stubEnv("TRUST_PROXY_HEADERS", "0");
    // Rig the limiter so that IF it were ever consulted it would HARD BLOCK:
    // the shared anonymous bucket is already way over its cap.
    mocks.execute.mockResolvedValue([{ count: 999, window_start: new Date() }]);

    // An attacker hammers the login with bad keys. Each must return the real
    // credential error — never the throttle message — because with no trusted
    // IP the limiter is skipped entirely (fail open).
    for (let i = 0; i < 15; i++) {
      const res = await loginAction({}, form("mantis_live_wrongwrongwrongwrong"));
      expect(res).toEqual({ error: "invalid or revoked API key" });
    }

    // The operator's valid login still goes through — it is NOT blocked by the
    // exhausted shared bucket (this is the lockout the fix prevents).
    mocks.selectRows = [VALID_ROW];
    await loginAction({}, form(VALID_KEY));
    expect(mocks.setSessionCookie).toHaveBeenCalledWith(VALID_ROW.id);
    expect(mocks.redirect).toHaveBeenCalledWith("/keys");

    // Core property: with no trusted IP the Postgres limiter is never touched,
    // so no shared bucket exists to exhaust.
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("trusted IP: failed logins still consume the per-IP limiter (brute-force protection intact)", async () => {
    vi.stubEnv("TRUST_PROXY_HEADERS", "1");
    mocks.headers = { "cf-connecting-ip": "203.0.113.5" };
    mocks.execute.mockResolvedValue([{ count: 1, window_start: new Date() }]);
    mocks.selectRows = []; // invalid key

    const res = await loginAction({}, form(VALID_KEY));
    expect(res).toEqual({ error: "invalid or revoked API key" });
    // A real IP means the cross-instance limiter IS engaged on the failure path.
    expect(mocks.execute).toHaveBeenCalledTimes(1);
  });

  it("trusted IP: an exhausted bucket blocks further FAILED logins but never a valid one", async () => {
    vi.stubEnv("TRUST_PROXY_HEADERS", "1");
    mocks.headers = { "cf-connecting-ip": "203.0.113.5" };
    // Bucket already over the cap.
    mocks.execute.mockResolvedValue([{ count: 11, window_start: new Date() }]);

    // A failed attempt past the cap is throttled.
    mocks.selectRows = [];
    const blocked = await loginAction({}, form(VALID_KEY));
    expect(blocked).toEqual({
      error: "too many attempts — try again in a minute",
    });
    const callsAfterFail = mocks.execute.mock.calls.length;

    // …but a VALID key is never sent through the limiter, so it still succeeds
    // even while the bucket is exhausted.
    mocks.selectRows = [VALID_ROW];
    await loginAction({}, form(VALID_KEY));
    expect(mocks.redirect).toHaveBeenCalledWith("/keys");
    expect(mocks.execute.mock.calls.length).toBe(callsAfterFail);
  });
});
