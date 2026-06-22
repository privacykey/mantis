import { describe, expect, it } from "vitest";
import { buildResponse } from "../src/response";

describe("buildResponse", () => {
  it("returns a 200 GIF by default", async () => {
    const res = buildResponse({ w: "https://x.com/h" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/gif");
    const buf = new Uint8Array(await res.arrayBuffer());
    expect(buf[0]).toBe(0x47); // 'G'
    expect(buf[1]).toBe(0x49); // 'I'
    expect(buf[2]).toBe(0x46); // 'F'
    // 1×1 transparent GIF is around 42-43 bytes depending on encoder.
    expect(buf.byteLength).toBeGreaterThanOrEqual(40);
    expect(buf.byteLength).toBeLessThanOrEqual(50);
  });

  it("returns 204 for r=empty", async () => {
    const res = buildResponse({ w: "https://x.com/h", r: "empty" });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
  });

  it("returns the JSON payload for r=json", async () => {
    const res = buildResponse({
      w: "https://x.com/h",
      r: "json",
      p: { ok: true, custom: "value" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(await res.json()).toEqual({ ok: true, custom: "value" });
  });

  it("returns a 302 redirect for r=redirect with valid url", () => {
    const res = buildResponse({
      w: "https://x.com/h",
      r: "redirect",
      p: { url: "https://example.com/target" },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://example.com/target");
  });

  it("falls back to gif when redirect payload is malformed", async () => {
    const res = buildResponse({
      w: "https://x.com/h",
      r: "redirect",
      p: { url: "javascript:alert(1)" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/gif");
  });

  it("returns HTML body for r=html", async () => {
    const res = buildResponse({
      w: "https://x.com/h",
      r: "html",
      p: { html: "<h1>hi</h1>" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await res.text()).toBe("<h1>hi</h1>");
  });

  it("sandboxes HTML responses with a CSP matching the stateful server", () => {
    const res = buildResponse({
      w: "https://x.com/h",
      r: "html",
      p: { html: "<h1>hi</h1>" },
    });
    const csp = res.headers.get("content-security-policy");
    expect(csp).not.toBeNull();
    // Critical pieces: no scripts (default-src 'none'), no plugins/JS via
    // sandbox without `allow-scripts`, no <base> hijack, no form action.
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("sandbox");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("form-action 'none'");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("redirects with cache-control: no-store so caches/proxies don't snapshot the target", () => {
    const res = buildResponse({
      w: "https://x.com/h",
      r: "redirect",
      p: { url: "https://example.com/target" },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://example.com/target");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});
