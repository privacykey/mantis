import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// E2E-03 — Login-lockout DoS regression (commit a3d143c2) against real Postgres.
// With no trusted client IP, the dashboard login must NOT touch the
// Postgres-backed limiter at all (else an anonymous flood collapses into one
// shared bucket and locks the operator out). With a trusted IP, failed logins
// consume the per-IP bucket and a flood is throttled — but a VALID credential
// is never throttled. The unit version (tests/login-dos.test.ts) mocks the DB;
// this drives the real consumeRateLimit UPSERT + the real api-key lookup.

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
import { db } from "@/db/client";
import { rateLimits } from "@/db/schema";
import { seedApiKey } from "./_harness";

const WRONG_KEY = `mantis_live_${"w".repeat(40)}`;

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

afterEach(() => {
  delete process.env.TRUST_PROXY_HEADERS;
});

describe("E2E-03 login lockout DoS", () => {
  it("no trusted IP: a bad-login flood never locks out a valid credential and never writes a bucket", async () => {
    delete process.env.TRUST_PROXY_HEADERS; // production default — no trusted IP

    const valid = await seedApiKey();

    for (let i = 0; i < 15; i++) {
      const res = await loginAction({}, form(WRONG_KEY));
      expect(res).toEqual({ error: "invalid or revoked API key" });
    }

    // The operator's valid login still goes through.
    await loginAction({}, form(valid.plaintext));
    expect(mocks.setSessionCookie).toHaveBeenCalledWith(valid.row.id);
    expect(mocks.redirect).toHaveBeenCalledWith("/keys");

    // Core property: with no trusted IP the limiter is never consulted, so no
    // shared bucket exists to exhaust.
    const buckets = await db.select().from(rateLimits);
    expect(buckets).toHaveLength(0);
  });

  it("trusted IP: a flood is throttled after the cap, but a valid key still logs in", async () => {
    process.env.TRUST_PROXY_HEADERS = "1";
    mocks.headers = { "cf-connecting-ip": "203.0.113.5" };

    const valid = await seedApiKey();

    // limit is 10/min: attempts 1..10 return the credential error, the 11th is
    // throttled.
    for (let i = 0; i < 10; i++) {
      const res = await loginAction({}, form(WRONG_KEY));
      expect(res).toEqual({ error: "invalid or revoked API key" });
    }
    const blocked = await loginAction({}, form(WRONG_KEY));
    expect(blocked).toEqual({
      error: "too many attempts — try again in a minute",
    });

    // A valid key is never sent through the limiter, so it succeeds even while
    // the bucket is exhausted.
    await loginAction({}, form(valid.plaintext));
    expect(mocks.redirect).toHaveBeenCalledWith("/keys");

    // A real per-IP bucket was created (cross-instance brute-force cap intact).
    const buckets = await db.select().from(rateLimits);
    expect(buckets.length).toBeGreaterThanOrEqual(1);
    expect(buckets.some((b) => b.key === "login:203.0.113.5")).toBe(true);
  });
});
