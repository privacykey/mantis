import { describe, expect, it } from "vitest";
import { parseMonitorSnapshot } from "@/lib/monitor-snapshot";

describe("monitor snapshot", () => {
  it("accepts authoritative tripped, healthy, and disabled states", () => {
    for (const state of ["off", "ok", "tripped"]) {
      const tripped_at = state === "tripped" ? "2026-10-01T12:00:00Z" : null;
      expect(parseMonitorSnapshot({ state, mode: "latch", window_seconds: 300, tripped_at }))
        .toEqual({ state, mode: "latch", windowSeconds: 300, trippedAt: tripped_at });
    }
  });
  it("refuses unavailable and incomplete replies", () => {
    expect(parseMonitorSnapshot({ error: "unavailable" })).toBeNull();
    expect(parseMonitorSnapshot({ state: "ok" })).toBeNull();
    expect(parseMonitorSnapshot({ state: "tripped", mode: "latch", window_seconds: 300, tripped_at: null })).toBeNull();
  });
});
