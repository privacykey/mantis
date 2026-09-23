import { describe, expect, it } from "vitest";
import { encodeHitCursor, parseHitCursor } from "@/lib/hit-cursor";

describe("hit cursors", () => {
  const hit = {
    id: "00000000-0000-4000-8000-000000000001",
    occurredAt: "2026-09-23T10:11:12.345123Z",
  };

  it("round trips timestamp and ID for stable pagination", () => {
    expect(parseHitCursor(encodeHitCursor(hit.occurredAt, hit.id))).toEqual({ at: hit.occurredAt, id: hit.id });
  });

  it("keeps legacy timestamp cursors readable", () => {
    expect(parseHitCursor(hit.occurredAt)).toEqual({ at: hit.occurredAt, id: null });
  });

  it("rejects malformed cursors", () => {
    expect(parseHitCursor("garbage")).toBeNull();
    expect(parseHitCursor(`${hit.occurredAt}~bad-id`)).toBeNull();
  });
});
