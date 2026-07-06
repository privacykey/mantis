import { describe, it, expect, vi, beforeEach } from "vitest";

// Enrollment-scoped keys are fleet-embedded credentials; a device user who
// extracts one must not be able to open the dashboard with it. Mirrors the
// mock scaffolding of login-lockout.test.ts.

const mocks = vi.hoisted(() => ({
  headers: {} as Record<string, string>,
  audit: vi.fn(),
  setSessionCookie: vi.fn(),
  redirect: vi.fn(),
}));

vi.mock("next/headers", () => ({
  headers: async () => ({
    get: (n: string) => mocks.headers[n.toLowerCase()] ?? null,
  }),
}));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("@/lib/session", () => ({ setSessionCookie: mocks.setSessionCookie }));
vi.mock("@/lib/audit", () => ({ audit: mocks.audit }));
vi.mock("@/lib/log", () => ({
  log: { info() {}, warn() {}, error() {}, debug() {}, fatal() {}, trace() {} },
}));

import { loginAction } from "@/app/login/actions";
import { seedApiKey } from "./_harness";

function form(key: string): FormData {
  const fd = new FormData();
  fd.set("api_key", key);
  return fd;
}

beforeEach(() => {
  mocks.headers = {};
  mocks.audit.mockReset();
  mocks.setSessionCookie.mockReset();
  mocks.redirect.mockReset();
});

describe("enroll keys cannot open dashboard sessions", () => {
  it("rejects a valid enroll key without creating a session", async () => {
    const enroll = await seedApiKey({ scope: "enroll" });

    const state = await loginAction({}, form(enroll.plaintext));

    expect(state.error).toMatch(/enrollment-scoped/);
    expect(mocks.setSessionCookie).not.toHaveBeenCalled();
    expect(mocks.redirect).not.toHaveBeenCalled();
  });

  it("still logs in a full key (sanity)", async () => {
    const full = await seedApiKey();

    await loginAction({}, form(full.plaintext));

    expect(mocks.setSessionCookie).toHaveBeenCalledWith(full.row.id);
    expect(mocks.redirect).toHaveBeenCalledWith("/keys");
  });
});
