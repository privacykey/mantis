import { describe, expect, it } from "vitest";
import type { RecentHitsPage } from "../src/lib/api.js";
import {
  HIT_OVERLAP_MS,
  HitTail,
  primeHitAnchor,
} from "../src/lib/hit-anchor.js";

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

describe("HitTail", () => {
  const T = Date.parse("2026-09-23T10:00:00.000Z");
  const at = (ms: number) => new Date(T + ms).toISOString();
  const h = (id: string, ms: number) => ({ id, occurred_at: at(ms) });
  const prime = (
    data: Array<{ id: string; occurred_at: string }> = [],
    nextCursor: string | null = null,
  ): RecentHitsPage => ({
    data: data as RecentHitsPage["data"],
    next_cursor: nextCursor,
    server_time: at(0),
  });

  it("keeps re-reading behind the watermark, so a late-visible hit is returned once", () => {
    const tail = new HitTail(prime());
    expect(tail.since()).toBe(at(-HIT_OVERLAP_MS));

    // B started at +5s and committed first.
    expect(tail.accept([h("B", 5_000)])).toEqual([h("B", 5_000)]);
    // A started at +3s but is only visible now: the next lower bound still
    // lies before it, and the repeat of B is dropped.
    expect(Date.parse(tail.since())).toBeLessThan(T + 3_000);
    expect(tail.accept([h("B", 5_000), h("A", 3_000)])).toEqual([h("A", 3_000)]);
    expect(tail.accept([h("B", 5_000), h("A", 3_000)])).toEqual([]);
  });

  it("returns new hits oldest first and never re-emits primed ones", () => {
    const tail = new HitTail(prime([h("seen", -1_000)]));
    expect(
      tail.accept([h("c", 3), h("b", 2), h("a", 1), h("seen", -1_000)]).map((x) => x.id),
    ).toEqual(["a", "b", "c"]);
  });

  it("emits a hit that arrived while priming (timestamp at or after the anchor)", () => {
    const tail = new HitTail(prime([h("during", 10), h("before", -10)]));
    expect(tail.accept([h("during", 10), h("before", -10)]).map((x) => x.id)).toEqual([
      "during",
    ]);
  });

  it("does not reach back past a prime page that was cut off", () => {
    // Complete page: the whole overlap window is known, so re-read all of it.
    expect(new HitTail(prime([h("p", -2_000)])).since()).toBe(at(-HIT_OVERLAP_MS));
    // Cut-off page: anything older than its last row was never seen and would
    // print as new, so the lower bound stops just before that row.
    const cut = new HitTail(prime([h("p2", -1_000), h("p1", -2_000)], "more"));
    expect(cut.since()).toBe(at(-2_001));
  });

  it("forgets ids once they fall behind the window and caps the set", () => {
    const tail = new HitTail(prime(), 60_000, 3);
    tail.accept([h("d", 4), h("c", 3), h("b", 2), h("a", 1)]);
    // Over the cap: the oldest id was forgotten, so it alone comes back.
    expect(
      tail.accept([h("d", 4), h("c", 3), h("b", 2), h("a", 1)]).map((x) => x.id),
    ).toEqual(["a"]);

    // A much newer hit moves the window; the lower bound follows it.
    tail.accept([h("late", 200_000)]);
    expect(tail.since()).toBe(at(140_000));
  });
});
