import { describe, expect, it } from "vitest";
import { buildTriggerResponse } from "@/lib/response";

// Locks the isolation guarantees around operator-supplied HTML served at
// /c/<publicId>. The sandbox CSP is what keeps that content from reaching the
// dashboard's cookies/storage; this test fails loudly if a future edit
// weakens it (e.g. adds allow-same-origin) — the regression #18 calls out.
describe("operator HTML response (buildTriggerResponse 'html')", () => {
  const res = buildTriggerResponse("html", { html: "<h1>decoy</h1>" });
  const csp = res.headers.get("Content-Security-Policy") ?? "";

  it("sandboxes the content into an opaque origin", () => {
    expect(csp.split(";").map((d) => d.trim())).toContain("sandbox");
  });

  it("never grants same-origin or script execution", () => {
    expect(csp).not.toContain("allow-same-origin");
    expect(csp).not.toContain("allow-scripts");
    expect(csp).not.toContain("allow-forms");
  });

  it("keeps the baseline lock-down directives", () => {
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("form-action 'none'");
    expect(csp).toContain("base-uri 'none'");
  });

  it("sets nosniff + cross-origin-resource-policy", () => {
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Cross-Origin-Resource-Policy")).toBe("same-origin");
  });

  it("serves as text/html and is not cached", () => {
    expect(res.headers.get("Content-Type")).toContain("text/html");
    expect(res.headers.get("Cache-Control")).toContain("no-store");
  });
});
