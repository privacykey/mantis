import { describe, it, expect, afterEach } from "vitest";

// E2E-11 — SSRF guard wired into the REAL outbound dispatcher (commit 5044e457).
// safePostJson must refuse private/metadata targets, refuse to follow redirects,
// and never echo a target's response body into the thrown error (no internal-
// response oracle). The control case proves the sink itself works when allowed.

import { safePostJson } from "@/lib/notify/safe-post";
import { SELF_DESTINATION } from "@/lib/notify/self-target";
import { REFUSED_DESTINATION } from "@/lib/ssrf";
import { startSink, type Sink } from "./_sink";

let sink: Sink | null = null;
afterEach(async () => {
  delete process.env.ALLOW_PRIVATE_WEBHOOKS;
  if (sink) {
    await sink.close();
    sink = null;
  }
});

describe("E2E-11 outbound SSRF guard", () => {
  it("refuses a loopback target and never connects to it", async () => {
    sink = await startSink({ status: 200 });
    // ALLOW_PRIVATE_WEBHOOKS unset ⇒ 127.0.0.1 is rejected pre-flight.
    await expect(safePostJson(sink.url, { x: 1 })).rejects.toThrow(REFUSED_DESTINATION);
    expect(sink.requests).toHaveLength(0);
  });

  it("refuses the cloud metadata IP", async () => {
    await expect(
      safePostJson("http://169.254.169.254/latest/meta-data/", {}),
    ).rejects.toThrow(REFUSED_DESTINATION);
  });

  it("refuses bracketed IPv6 loopback and IPv4-mapped literals", async () => {
    sink = await startSink({ status: 200 });
    const port = new URL(sink.url).port;
    for (const host of ["[::1]", "[::ffff:127.0.0.1]", "[::ffff:7f00:1]"]) {
      await expect(
        safePostJson(`http://${host}:${port}/hook`, { x: 1 }),
      ).rejects.toThrow(REFUSED_DESTINATION);
    }
    expect(sink.requests).toHaveLength(0);
  });

  it("refuses a name that resolves to loopback without saying what it resolved to", async () => {
    // Resolved by the real resolver (hosts file). The error text reaches
    // whoever created the destination, so it carries no resolver answer;
    // tests/ssrf.test.ts pins that a non-existent name reads the same.
    const err = await safePostJson("http://localhost:9/hook", {}).catch((e: unknown) => e);
    expect((err as Error).message).toBe(REFUSED_DESTINATION);
    expect(REFUSED_DESTINATION).not.toMatch(/127\.0\.0\.1|::1|localhost/);
  });

  it("refuses a non-http(s) scheme", async () => {
    await expect(safePostJson("file:///etc/passwd", {})).rejects.toThrow(
      /scheme/i,
    );
  });

  it("refuses to follow a 3xx redirect", async () => {
    process.env.ALLOW_PRIVATE_WEBHOOKS = "1";
    sink = await startSink({ redirectTo: "http://169.254.169.254/" });
    await expect(safePostJson(sink.url, { x: 1 })).rejects.toThrow(/redirect/i);
    // It POSTed once but did not follow the Location.
    expect(sink.requests).toHaveLength(1);
  });

  it("reports a redirect by status and Location origin, never its path or query", async () => {
    process.env.ALLOW_PRIVATE_WEBHOOKS = "1";
    sink = await startSink({
      redirectTo: "https://ha.example.net/api/webhook/super-secret-ha-webhook-id?token=abc",
    });
    const err = await safePostJson(sink.url, { x: 1 }).catch((e: unknown) => e);
    expect((err as Error).message).toBe(
      "HTTP 302 redirect to https://ha.example.net — refusing to follow",
    );
  });

  it("does not leak the target's response body into the error (no oracle)", async () => {
    process.env.ALLOW_PRIVATE_WEBHOOKS = "1";
    sink = await startSink({ status: 500, body: "BODY_ORACLE_LEAK_SECRET" });
    let err: unknown;
    try {
      await safePostJson(sink.url, { x: 1 });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/500/);
    expect((err as Error).message).not.toContain("BODY_ORACLE_LEAK_SECRET");
  });

  it("delivers to the same sink when ALLOW_PRIVATE_WEBHOOKS=1 (control)", async () => {
    process.env.ALLOW_PRIVATE_WEBHOOKS = "1";
    sink = await startSink({ status: 200 });
    await expect(safePostJson(sink.url, { x: 1 })).resolves.toBeUndefined();
    expect(sink.requests).toHaveLength(1);
  });

  it("refuses this instance's own origin even when private targets are allowed", async () => {
    // PUBLIC_BASE_URL is http://localhost:3000 in this suite: a delivery there
    // would land on our own trigger route and be recorded as a hit.
    process.env.ALLOW_PRIVATE_WEBHOOKS = "1";
    for (const url of ["http://localhost:3000/c/AbCdEf1234", "http://127.0.0.1:3000/c/AbCdEf1234"]) {
      await expect(safePostJson(url, { type: "mantis.hit" })).rejects.toThrow(SELF_DESTINATION);
    }
  });
});
