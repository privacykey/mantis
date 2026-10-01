import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const fixtures = vi.hoisted(() => ({
  lookup: vi.fn(),
  touch: vi.fn(),
  session: vi.fn(),
  limiter: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  monitor: vi.fn(),
}));

vi.mock("@/db/client", () => ({
  db: {
    select: () => ({ from: () => ({ where: () => ({ limit: fixtures.lookup }) }) }),
    update: () => ({ set: () => ({ where: fixtures.touch }) }),
  },
}));
vi.mock("@/lib/session", () => ({ getSessionApiKey: fixtures.session }));
vi.mock("@/lib/rate-limit", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/rate-limit")>(),
  consumeRateLimit: fixtures.limiter,
}));
vi.mock("@/lib/log", () => ({ log: { warn: fixtures.warn, error: fixtures.error } }));
vi.mock("@/lib/monitor", () => ({ computeMonitorState: fixtures.monitor }));

import { requireApiKey, requireApiKeyOrSession, type AuthResult } from "@/lib/auth";
import { hashApiKey } from "@/lib/api-keys";
import { GET as monitorStatus } from "@/app/api/keys/[id]/monitor/route";

const BEARER = `mantis_live_${"a".repeat(32)}`;
const KEY_ID = "4e0e6a21-2254-45ae-9c68-b23069f3b098";
const apiKey = {
  id: "owner",
  hash: hashApiKey(BEARER),
  scope: "full",
  isAdmin: false,
};
const canary = {
  id: KEY_ID,
  createdByApiKeyId: apiKey.id,
  monitorMode: "latch",
  monitorWindowSeconds: 60,
};
const authenticators = [
  ["API-only", requireApiKey],
  ["Bearer-or-session", requireApiKeyOrSession],
] as const;

function request(bearer: string | null = BEARER) {
  return new NextRequest(`http://localhost:3000/api/keys/${KEY_ID}/monitor`, {
    headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
  });
}

function failedResponse(auth: AuthResult) {
  expect(auth.ok).toBe(false);
  if (auth.ok) throw new Error("unexpected authentication success");
  return auth.res;
}

async function expectUnavailable(response: Response) {
  expect(response.status).toBe(503);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("retry-after")).toBe("1");
  expect(await response.json()).toEqual({
    error: "unavailable",
    message: "authentication is temporarily unavailable",
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  fixtures.lookup.mockResolvedValue([apiKey]);
  fixtures.touch.mockResolvedValue(undefined);
  fixtures.session.mockResolvedValue(null);
  fixtures.limiter.mockResolvedValue({ ok: true, remaining: 59, resetAt: Date.now() + 60_000 });
  fixtures.monitor.mockResolvedValue({ kind: "ok" });
});

describe.each(authenticators)("%s dependency recovery", (_name, authenticate) => {
  it("fails closed with a retryable response when credential lookup rejects", async () => {
    fixtures.lookup.mockRejectedValue(new Error(`connection failed: ${BEARER}`));
    await expectUnavailable(failedResponse(await authenticate(request())));
    expect(fixtures.limiter).not.toHaveBeenCalled();
    expect(fixtures.session).not.toHaveBeenCalled();
    expect(fixtures.warn).toHaveBeenCalledExactlyOnceWith("authentication dependency unavailable");
    expect(JSON.stringify(fixtures.warn.mock.calls)).not.toContain(BEARER);
  });

  it("catches an asynchronous failure-limiter rejection", async () => {
    fixtures.lookup.mockResolvedValue([]);
    fixtures.limiter.mockRejectedValue(new Error("limiter dependency unavailable"));
    await expectUnavailable(failedResponse(await authenticate(request())));
  });

  it.each(["malformed", BEARER])("keeps invalid or revoked credentials at 401: %s", async (bearer) => {
    fixtures.lookup.mockResolvedValue([]);
    const response = failedResponse(await authenticate(request(bearer)));
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("Bearer");
    expect((await response.json()).error).toBe("unauthorized");
    expect(fixtures.limiter).toHaveBeenCalledOnce();
  });

  it("keeps enrollment credentials forbidden without consuming the limiter", async () => {
    fixtures.lookup.mockResolvedValue([{ ...apiKey, scope: "enroll" }]);
    const response = failedResponse(await authenticate(request()));
    expect(response.status).toBe(403);
    expect((await response.json()).error).toBe("forbidden");
    expect(fixtures.limiter).not.toHaveBeenCalled();
  });

  it("preserves the failure throttle", async () => {
    fixtures.lookup.mockResolvedValue([]);
    fixtures.limiter.mockResolvedValue({ ok: false, remaining: 0, resetAt: Date.now() + 60_000 });
    const response = failedResponse(await authenticate(request()));
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBeTruthy();
  });

  it("authenticates valid credentials even if the optional last-used touch fails", async () => {
    fixtures.touch.mockRejectedValue(new Error("optional telemetry update failed"));
    expect(await authenticate(request())).toEqual({ ok: true, key: apiKey });
    expect(fixtures.limiter).not.toHaveBeenCalled();
    expect(fixtures.warn).not.toHaveBeenCalled();
  });
});

describe("session and credential precedence", () => {
  it("returns retryable unavailability when session resolution rejects", async () => {
    fixtures.session.mockRejectedValue(new Error("private session token or connection details"));
    await expectUnavailable(failedResponse(await requireApiKeyOrSession(request(null))));
    expect(fixtures.lookup).not.toHaveBeenCalled();
    expect(fixtures.warn).toHaveBeenCalledExactlyOnceWith("authentication dependency unavailable");
  });

  it("authenticates a valid dashboard session", async () => {
    fixtures.session.mockResolvedValue(apiKey);
    expect(await requireApiKeyOrSession(request(null))).toEqual({ ok: true, key: apiKey });
    expect(fixtures.lookup).not.toHaveBeenCalled();
    expect(fixtures.limiter).not.toHaveBeenCalled();
  });

  it.each(authenticators)("keeps missing credentials unauthorized for %s", async (_name, authenticate) => {
    expect(failedResponse(await authenticate(request(null))).status).toBe(401);
  });

  it("does not substitute a valid session for an invalid bearer", async () => {
    fixtures.lookup.mockResolvedValue([]);
    fixtures.session.mockResolvedValue(apiKey);
    expect(failedResponse(await requireApiKeyOrSession(request())).status).toBe(401);
    expect(fixtures.session).not.toHaveBeenCalled();
  });

  it("does not substitute a session after a bearer lookup outage", async () => {
    fixtures.lookup.mockRejectedValue(new Error("database unavailable"));
    fixtures.session.mockResolvedValue(apiKey);
    await expectUnavailable(failedResponse(await requireApiKeyOrSession(request())));
    expect(fixtures.session).not.toHaveBeenCalled();
  });

  it("still allows enrollment only when the API route explicitly opts in", async () => {
    const enrollment = { ...apiKey, scope: "enroll" };
    fixtures.lookup.mockResolvedValue([enrollment]);
    expect(await requireApiKey(request(), { allowEnroll: true })).toEqual({ ok: true, key: enrollment });
  });
});

describe("monitor route authentication boundary", () => {
  const read = (req = request()) => monitorStatus(req, { params: Promise.resolve({ id: KEY_ID }) });

  it("returns structured unavailability before the monitor or ownership query on auth outage", async () => {
    fixtures.lookup.mockRejectedValue(new Error("database unavailable"));
    await expectUnavailable(await read());
    expect(fixtures.lookup).toHaveBeenCalledOnce();
    expect(fixtures.monitor).not.toHaveBeenCalled();
  });

  it("returns unavailability for a dashboard session outage", async () => {
    fixtures.session.mockRejectedValue(new Error("database unavailable"));
    await expectUnavailable(await read(request(null)));
    expect(fixtures.lookup).not.toHaveBeenCalled();
    expect(fixtures.monitor).not.toHaveBeenCalled();
  });

  it("preserves successful owner monitor reads", async () => {
    fixtures.lookup.mockResolvedValueOnce([apiKey]).mockResolvedValueOnce([canary]);
    const response = await read();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ state: "ok", tripped_at: null, mode: "latch", window_seconds: 60 });
    expect(fixtures.monitor).toHaveBeenCalledExactlyOnceWith(canary);
  });

  it("keeps another owner's key hidden", async () => {
    fixtures.lookup.mockResolvedValueOnce([apiKey]).mockResolvedValueOnce([{ ...canary, createdByApiKeyId: "stranger" }]);
    const response = await read();
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
    expect(fixtures.monitor).not.toHaveBeenCalled();
  });

  it("preserves administrator access", async () => {
    fixtures.lookup.mockResolvedValueOnce([{ ...apiKey, isAdmin: true }]).mockResolvedValueOnce([{ ...canary, createdByApiKeyId: "stranger" }]);
    expect((await read()).status).toBe(200);
  });

  it("rejects enrollment before any monitor query", async () => {
    fixtures.lookup.mockResolvedValue([{ ...apiKey, scope: "enroll" }]);
    expect((await read()).status).toBe(403);
    expect(fixtures.lookup).toHaveBeenCalledOnce();
    expect(fixtures.monitor).not.toHaveBeenCalled();
  });
});
