import { describe, expect, it } from "vitest";
import type { RecentHitsPage } from "../src/lib/api.js";
import { primeHitAnchor } from "../src/lib/hit-anchor.js";

function page(serverTime?: string): RecentHitsPage {
  return {
    data: [
      { id: "older", occurred_at: "2026-09-23T10:00:00.000Z" },
      { id: "during-prime", occurred_at: "2026-09-23T10:00:01.000Z" },
    ] as RecentHitsPage["data"],
    next_cursor: null,
    ...(serverTime ? { server_time: serverTime } : {}),
  };
}

describe("live hit anchor", () => {
  it("uses server time and leaves hits arriving during priming unseen", () => {
    expect(primeHitAnchor(page("2026-09-23T10:00:00.500Z"))).toEqual({
      watermarkMs: Date.parse("2026-09-23T10:00:00.500Z"),
      seenIds: ["older"],
    });
  });

  it("uses existing hits when an older server omits the anchor", () => {
    expect(primeHitAnchor(page())).toEqual({
      watermarkMs: Date.parse("2026-09-23T10:00:01.000Z"),
      seenIds: ["older", "during-prime"],
    });
    expect(primeHitAnchor({ data: [], next_cursor: null })).toEqual({
      watermarkMs: 0,
      seenIds: [],
    });
  });
});
