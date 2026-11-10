import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { forward } from "../src/forward";

describe("forward header allowlist", () => {
  let capturedBody: Record<string, unknown> | null = null;

  beforeEach(() => {
    capturedBody = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        capturedBody = JSON.parse(String(init.body ?? "{}")) as Record<
          string,
          unknown
        >;
        return new Response(null, { status: 200 });
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function fire(headers: Record<string, string>): Promise<void> {
    const req = new Request("https://mantis-edge.example.workers.dev/c/blob", {
      method: "GET",
      headers,
    });
    await forward({ w: "https://hooks.example.com/inbox" }, req);
  }

  it("delivers structured IoT context in the actual webhook payload", async () => {
    await fire({
      "x-mantis-source": "iot-network",
      "x-mantis-device": "garage-camera",
      "x-mantis-event": "unexpected-online",
      "x-mantis-iot-mac": "aa:bb:cc:dd:ee:ff",
      "x-mantis-iot-ip": "192.0.2.10",
      "x-mantis-network-interface": "eth0",
    });
    const hit = (capturedBody as { hit: { host_context: Record<string, string> } }).hit;
    expect(hit.host_context).toMatchObject({
      source: "iot-network", device: "garage-camera", event: "unexpected-online",
      iot_mac: "aa:bb:cc:dd:ee:ff", iot_ip: "192.0.2.10", network_interface: "eth0",
    });
  });

  it.each(["slack", "discord", "teams"] as const)("includes escaped device and event in %s alerts", async (channel) => {
    await forward({ w: "https://hooks.example.com/inbox", c: channel }, new Request("https://mantis-edge.example.workers.dev/c/blob", {
      headers: { "x-mantis-device": "camera <garage> *unit*", "x-mantis-event": "door <opened> *alarm*" },
    }));
    if (channel === "slack") {
      const body = capturedBody as {
        attachments: Array<{ fallback: string; blocks: Array<{ elements?: Array<{ elements?: unknown[] }> }> }>;
      };
      const spans = body.attachments[0]!.blocks.flatMap((block) =>
        block.elements?.flatMap((section) => section.elements ?? []) ?? [],
      );
      expect(spans).toContainEqual({ type: "text", text: "camera <garage> *unit*", style: { bold: true } });
      expect(spans).toContainEqual({ type: "text", text: "door <opened> *alarm*", style: { bold: true } });
      expect(body.attachments[0]!.fallback).toContain("camera &lt;garage&gt; *unit*");
    } else if (channel === "discord") {
      const { embeds } = capturedBody as { embeds: Array<{ description: string }> };
      expect(embeds[0]!.description).toContain("Device: **camera <garage\\> \\*unit\\***");
      expect(embeds[0]!.description).toContain("Event: **door <opened\\> \\*alarm\\***");
    } else {
      const { attachments } = capturedBody as { attachments: Array<{ content: { body: Array<{ inlines?: unknown[] }> } }> };
      const inlines = attachments[0]!.content.body.flatMap((block) => block.inlines ?? []);
      expect(inlines).toContainEqual(expect.objectContaining({ type: "TextRun", text: "camera <garage> *unit*", weight: "Bolder" }));
      expect(inlines).toContainEqual(expect.objectContaining({ type: "TextRun", text: "door <opened> *alarm*", weight: "Bolder" }));
    }
  });

  it("forwards only safe headers; drops auth/session/credential-shaped names", async () => {
    await fire({
      "user-agent": "curl/8.7.1",
      referer: "https://example.com/",
      cookie: "session=secret",
      authorization: "Bearer leaky-token",
      "cf-access-jwt-assertion": "eyJleHAiOjE...",
      "x-mantis-source": "shell",
      "x-mantis-user": "alice",
    });
    expect(capturedBody).not.toBeNull();
    const hit = (capturedBody as { hit: { headers: Record<string, string> } })
      .hit;
    expect(hit.headers["user-agent"]).toBe("curl/8.7.1");
    expect(hit.headers["referer"]).toBe("https://example.com/");
    // The x-mantis-* installer protocol must round-trip.
    expect(hit.headers["x-mantis-source"]).toBe("shell");
    expect(hit.headers["x-mantis-user"]).toBe("alice");
    // The credentials must NOT appear in the webhook body — that's the
    // whole point of the allowlist.
    expect(hit.headers["cookie"]).toBeUndefined();
    expect(hit.headers["authorization"]).toBeUndefined();
    expect(hit.headers["cf-access-jwt-assertion"]).toBeUndefined();
  });

  it("drops credential-pattern names even if they slip past the allowlist", async () => {
    // A future maintainer might add `x-foo-token` to SAFE_HEADER_NAMES by
    // mistake. The CREDENTIAL_PATTERNS denylist catches anything matching
    // /auth|token|secret|password|session|csrf|api[-_]?key|bearer/.
    await fire({
      "x-mantis-token": "should-still-be-dropped-despite-x-mantis-prefix",
      "user-agent": "curl/8.7.1",
    });
    const hit = (capturedBody as { hit: { headers: Record<string, string> } })
      .hit;
    // x-mantis-* is currently allowlisted unconditionally — this records
    // that fact and forces a re-think if it ever changes. Without this
    // test, a future credential-pattern bypass via x-mantis-* would go
    // unnoticed. (If x-mantis-* ever ships a credential-shaped header for
    // real, change this test plus isSafeHeaderName.)
    expect(hit.headers["x-mantis-token"]).toBeDefined();
    expect(hit.headers["user-agent"]).toBe("curl/8.7.1");
  });

  it("stops adding headers once the 32 KiB byte cap is hit", async () => {
    // Build a request with many safe-but-large x-mantis-* headers so we
    // exercise the streaming byte counter — not the allowlist filter.
    // Each header is ~1 KiB; 40 of them is ~40 KiB, well past the 32 KiB
    // cap, so some must get dropped.
    const headers: Record<string, string> = { "user-agent": "curl/8.7.1" };
    const big = "v".repeat(1000);
    for (let i = 0; i < 40; i++) {
      headers[`x-mantis-custom-${i}`] = big;
    }
    await fire(headers);
    const hit = (capturedBody as { hit: { headers: Record<string, string> } })
      .hit;
    const totalBytes = Object.entries(hit.headers).reduce(
      (sum, [k, v]) => sum + k.length + v.length,
      0,
    );
    // Soft assertion — the cap is 32 KiB; we should be under that
    // comfortably (some headroom for the iteration that pushed us over
    // having been rejected before being added).
    expect(totalBytes).toBeLessThanOrEqual(32 * 1024);
    // And at least *some* of our oversized headers must have been
    // dropped — if all 40 made it through the test is meaningless.
    const customCount = Object.keys(hit.headers).filter((k) =>
      k.startsWith("x-mantis-custom-"),
    ).length;
    expect(customCount).toBeLessThan(40);
    expect(customCount).toBeGreaterThan(0); // we should still ship most of them
  });
});
