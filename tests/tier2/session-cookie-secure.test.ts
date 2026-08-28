import { describe, expect, it } from "vitest";
import { seedApiKey } from "../integration/_harness";
import {
  DASHBOARD_HOST,
  extractActionFields,
  multipartForm,
  rawRequest,
} from "./_client";

// Tier-2: proves the Set-Cookie header the production server REALLY emits on
// login carries (or omits) the Secure attribute per the forwarded scheme.
// Handler-level tests can only observe the mocked cookie jar's arguments;
// whether `secure: boolean` survives serialization into the wire header is
// runtime behavior only a real `next start`-equivalent server can show.
//
// The login form is a server action, driven here exactly like a no-JS browser:
// GET the page, scrape React's hidden $ACTION fields, POST them back as
// multipart/form-data. A successful login answers 303 → /keys (MPA mode) with
// the mantis_session cookie on the redirect.

type LoginResult = {
  status: number;
  location: string | null;
  cookie: string | null;
  attrs: Set<string>;
};

async function loginVia(headers: Record<string, string>): Promise<LoginResult> {
  const { plaintext } = await seedApiKey({ name: "tier2-login" });

  const page = await rawRequest("/login", { host: DASHBOARD_HOST });
  expect(page.status).toBe(200);
  const actionFields = extractActionFields(page.body);
  expect(actionFields.length).toBeGreaterThan(0);

  const { contentType, body } = multipartForm([
    ...actionFields,
    ["api_key", plaintext],
  ]);
  const res = await rawRequest("/login", {
    method: "POST",
    host: DASHBOARD_HOST,
    headers: {
      "content-type": contentType,
      "content-length": String(body.length),
      accept: "text/html",
      ...headers,
    },
    body,
  });

  const cookie =
    res.setCookies.find((c) => c.startsWith("mantis_session=")) ?? null;
  // Attribute names (lowercased) after the value pair — "secure", "httponly",
  // "samesite", "path", "max-age", …
  const attrs = new Set(
    (cookie ?? "")
      .split(";")
      .slice(1)
      .map((a) => a.trim().toLowerCase().split("=")[0] ?? "")
      .filter(Boolean),
  );
  const location = res.headers.location;
  return {
    status: res.status,
    location: typeof location === "string" ? location : null,
    cookie,
    attrs,
  };
}

describe("session cookie Secure attribute (real Set-Cookie header)", () => {
  it("marks the cookie Secure when X-Forwarded-Proto says https", async () => {
    const r = await loginVia({
      "x-forwarded-proto": "https",
      origin: `https://${DASHBOARD_HOST}`,
    });
    expect(r.status).toBe(303);
    expect(r.location).toContain("/keys");
    expect(r.cookie).toBeTruthy();
    expect(r.attrs.has("secure")).toBe(true);
    expect(r.attrs.has("httponly")).toBe(true);
    expect(r.cookie!.toLowerCase()).toContain("samesite=lax");
    expect(r.cookie!).toContain("Path=/");
    expect(r.attrs.has("max-age")).toBe(true);
  });

  it("omits Secure on plain HTTP so the browser will send the cookie back", async () => {
    // The inverse matters just as much: an always-Secure cookie on a plaintext
    // deployment is never returned by the browser, which bricks login.
    const r = await loginVia({ origin: `http://${DASHBOARD_HOST}` });
    expect(r.status).toBe(303);
    expect(r.location).toContain("/keys");
    expect(r.cookie).toBeTruthy();
    expect(r.attrs.has("secure")).toBe(false);
    expect(r.attrs.has("httponly")).toBe(true);
  });

  it("honours RFC 7239 `Forwarded: proto=https` as the HTTPS signal", async () => {
    const r = await loginVia({
      forwarded: "proto=https",
      origin: `https://${DASHBOARD_HOST}`,
    });
    expect(r.status).toBe(303);
    expect(r.location).toContain("/keys");
    expect(r.cookie).toBeTruthy();
    expect(r.attrs.has("secure")).toBe(true);
  });
});
