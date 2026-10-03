import { afterEach, describe, expect, it } from "vitest";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import {
  clearCaptures,
  isCredentialHeader,
  listCaptures,
  pushCapture,
  redactCredentialHeaders,
  truncateBody,
} from "@/lib/inbox";

const MAX_BODY = 64 * 1024;

afterEach(() => clearCaptures());

describe("dev inbox — truncateBody", () => {
  it("passes short bodies through untouched", () => {
    expect(truncateBody("hello")).toEqual({ body: "hello", truncated: false });
    const exact = "a".repeat(MAX_BODY);
    expect(truncateBody(exact)).toEqual({ body: exact, truncated: false });
  });

  it("keeps exactly the first 64 KiB of code units of a longer body", () => {
    const text = `${"a".repeat(MAX_BODY - 2)}é😀${"z".repeat(1000)}`;
    const { body, truncated } = truncateBody(text);
    expect(truncated).toBe(true);
    expect(body).toHaveLength(MAX_BODY);
    // Identical to the plain slice, including the emoji's now-lone high
    // surrogate at the cut — the copy must not alter what is shown.
    expect(body).toBe(text.slice(0, MAX_BODY));
  });

  // A slice of a long string is a view onto its parent in V8, so storing the
  // slice kept each capture's whole decoded body (1 MiB read cap, 2 MiB once
  // invalid UTF-8 has decoded to two-byte U+FFFD) alive in the ring buffer:
  // ~40 MiB for the 20 captures below instead of ~2.5 MiB.
  it("does not pin the full request body in the ring buffer", () => {
    setFlagsFromString("--expose-gc");
    const gc = runInNewContext("gc") as () => void;
    const retained = () => {
      gc();
      gc(); // second pass: backing stores released by the first are accounted
      const m = process.memoryUsage();
      return m.heapUsed + m.external;
    };

    const CAPTURES = 20;
    const before = retained();
    for (let i = 0; i < CAPTURES; i++) {
      // The route's exact sequence: decode the raw bytes into one flat string
      // (0xFF is invalid UTF-8 → U+FFFD), truncate, store.
      const raw = new TextDecoder().decode(Buffer.alloc(1024 * 1024, 0xff));
      expect(raw.length).toBe(1024 * 1024);
      const { body, truncated } = truncateBody(raw);
      pushCapture({
        method: "POST",
        slug: "flood",
        url: "/inbox/flood",
        headers: {},
        body,
        body_truncated: truncated,
      });
    }
    const grown = retained() - before;

    expect(listCaptures()).toHaveLength(CAPTURES);
    expect(listCaptures().every((c) => c.body.length === MAX_BODY)).toBe(true);
    // 64 KiB of two-byte text is 128 KiB per capture; allow double that.
    expect(grown).toBeLessThan(CAPTURES * 256 * 1024);
  });
});

describe("dev inbox — credential headers are never stored", () => {
  it("flags ambient credentials and leaves ordinary webhook headers alone", () => {
    for (const name of [
      "cookie",
      "Cookie",
      "authorization",
      "Proxy-Authorization",
      "x-api-key",
      "x-auth-token",
      "x-csrf-token",
      "cf-access-jwt-assertion",
      "cf-access-client-id",
      "cf-access-client-secret",
      "x-amz-security-token",
      "x-amzn-oidc-data",
      "x-session-id",
    ]) {
      expect(isCredentialHeader(name), name).toBe(true);
    }
    for (const name of [
      "content-type",
      "user-agent",
      "host",
      "x-forwarded-for",
      "x-mantis-signature",
      "x-mantis-timestamp",
      "x-mantis-source",
      "sec-fetch-site",
      "referer",
    ]) {
      expect(isCredentialHeader(name), name).toBe(false);
    }
  });

  it("keeps the header name and replaces only the value", () => {
    expect(
      redactCredentialHeaders({
        cookie: "mantis_session=mantis_sess_abc",
        Authorization: "Bearer mantis_live_abc",
        "content-type": "application/json",
      }),
    ).toEqual({
      cookie: "[redacted]",
      Authorization: "[redacted]",
      "content-type": "application/json",
    });
  });

  it("redacts at pushCapture, so no caller can store a credential", () => {
    const input = {
      cookie: "mantis_session=mantis_sess_abc",
      "x-mantis-signature": "t=1,v1=abc",
    };
    const cap = pushCapture({
      method: "GET",
      slug: "lure",
      url: "/inbox/lure",
      headers: input,
      body: "",
      body_truncated: false,
    });
    expect(cap.headers).toEqual({
      cookie: "[redacted]",
      "x-mantis-signature": "t=1,v1=abc",
    });
    expect(JSON.stringify(listCaptures())).not.toContain("mantis_sess_abc");
    // The caller's object is not mutated.
    expect(input.cookie).toBe("mantis_session=mantis_sess_abc");
  });
});
