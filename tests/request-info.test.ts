import { afterEach, describe, expect, it, vi } from "vitest";
import {
  capStoredRequestField,
  snapshotHeaders,
} from "@/lib/request-info";

describe("request info capture caps", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("preserves ordinary request fields", () => {
    expect(capStoredRequestField("curl/8.0")).toBe("curl/8.0");
    expect(capStoredRequestField(null)).toBeNull();
  });

  it("marks oversized request fields when capped", () => {
    vi.stubEnv("MANTIS_MAX_STORED_REQUEST_FIELD_CHARS", "256");
    const capped = capStoredRequestField("a".repeat(300));
    expect(capped).toHaveLength(256);
    expect(capped?.endsWith("[mantis-truncated]")).toBe(true);
  });

  it("caps stored header snapshots and records a truncation marker", () => {
    vi.stubEnv("MANTIS_MAX_STORED_REQUEST_FIELD_CHARS", "256");
    vi.stubEnv("MANTIS_MAX_STORED_HEADER_SNAPSHOT_CHARS", "1024");

    const req = new Request("http://localhost/c/abc123", {
      headers: {
        "User-Agent": "mantis-test",
        "X-Mantis-Source": "shell",
        "X-Mantis-Host": "h".repeat(2000),
      },
    });

    const headers = snapshotHeaders(req as never);
    expect(headers["user-agent"]).toBe("mantis-test");
    expect(headers["x-mantis-source"]).toBe("shell");
    expect(headers["x-mantis-host"]).toHaveLength(256);
    expect(headers["x-mantis-capture-truncated"]).toBe("headers");
  });
});
