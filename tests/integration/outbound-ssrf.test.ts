import { describe, it, expect, afterEach } from "vitest";

// E2E-11 — SSRF guard wired into the REAL outbound dispatcher (commit 5044e457).
// safePostJson must refuse private/metadata targets, refuse to follow redirects,
// and never echo a target's response body into the thrown error (no internal-
// response oracle). The control case proves the sink itself works when allowed.

import { safePostJson } from "@/lib/notify/safe-post";
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
    await expect(safePostJson(sink.url, { x: 1 })).rejects.toThrow(/private/i);
    expect(sink.requests).toHaveLength(0);
  });

  it("refuses the cloud metadata IP", async () => {
    await expect(
      safePostJson("http://169.254.169.254/latest/meta-data/", {}),
    ).rejects.toThrow(/private/i);
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
});
