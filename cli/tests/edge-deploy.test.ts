import { describe, expect, it } from "vitest";
import { parseWorkerUrl } from "../src/commands/edge.js";

describe("parseWorkerUrl", () => {
  it("lifts the workers.dev URL out of typical wrangler output", () => {
    const out = [
      "Total Upload: 120.34 KiB / gzip: 40.12 KiB",
      "Uploaded mantis-edge (1.20 sec)",
      "Deployed mantis-edge triggers (0.80 sec)",
      "  https://mantis-edge.acme.workers.dev",
      "Current Version ID: 1a2b3c",
    ].join("\n");
    expect(parseWorkerUrl(out)).toBe("https://mantis-edge.acme.workers.dev");
  });

  it("prefers a workers.dev URL over other https URLs in the output", () => {
    const out = [
      "Reading wrangler.toml (see https://developers.cloudflare.com for docs)",
      "Deployed mantis-edge triggers",
      "  https://mantis-edge.acme.workers.dev",
    ].join("\n");
    expect(parseWorkerUrl(out)).toBe("https://mantis-edge.acme.workers.dev");
  });

  it("falls back to the first valid https URL (custom domain, no workers.dev)", () => {
    const out = [
      "Deployed mantis-edge triggers (0.5 sec)",
      "  https://canary.example.com/*",
    ].join("\n");
    expect(parseWorkerUrl(out)).toBe("https://canary.example.com/*");
  });

  it("strips trailing punctuation around a URL", () => {
    expect(parseWorkerUrl("see (https://mantis-edge.acme.workers.dev).")).toBe(
      "https://mantis-edge.acme.workers.dev",
    );
  });

  it("returns null when there is no URL", () => {
    expect(parseWorkerUrl("Authentication error [code: 10000]")).toBeNull();
    expect(parseWorkerUrl("")).toBeNull();
  });
});
