import type { RecentHitsPage } from "./api.js";

/** Seed a live stream from database time, never from the operator's clock. */
export function primeHitAnchor(page: RecentHitsPage): {
  watermarkMs: number;
  seenIds: string[];
} {
  const serverMs = Date.parse(page.server_time ?? "");
  if (Number.isFinite(serverMs)) {
    return {
      watermarkMs: serverMs,
      seenIds: page.data
        .filter((hit) => Date.parse(hit.occurred_at) < serverMs)
        .map((hit) => hit.id),
    };
  }

  // Older servers do not return server_time. Anchor at their newest hit, or
  // the epoch for an empty feed, so local clock skew still cannot skip hits.
  return {
    watermarkMs: Math.max(0, ...page.data.map((hit) => Date.parse(hit.occurred_at))),
    seenIds: page.data.map((hit) => hit.id),
  };
}

/**
 * How far behind its watermark a live tail re-reads on every poll.
 *
 * A hit's occurred_at is stamped when its capture starts, but the hit only
 * becomes visible once that capture commits. A hit that started earlier can
 * therefore appear after a later-timestamped one was already returned, and a
 * tail that only asks for "newer than the newest I have seen" would skip it
 * for good. Re-reading this window on every poll (and dropping repeats by id)
 * picks up any hit that lands within it.
 */
export const HIT_OVERLAP_MS = 60_000;

/** Upper bound on remembered hit ids, whatever the hit rate. */
export const HIT_SEEN_MAX = 20_000;

// A hit can only be returned again while its timestamp is inside the re-read
// window. The slack absorbs sub-millisecond timestamps that the server
// compares exactly but we only see rounded.
const PRUNE_SLACK_MS = 1_000;

type TailHit = { id: string; occurred_at: string };

/**
 * Watermark + de-duplication state shared by `mantis watch` and
 * `mantis hits --follow`.
 */
export class HitTail {
  private watermarkMs: number;
  private readonly floorMs: number;
  // id -> occurred_at (ms), in insertion order.
  private readonly seen = new Map<string, number>();

  constructor(
    prime: RecentHitsPage,
    private readonly overlapMs: number = HIT_OVERLAP_MS,
    private readonly seenMax: number = HIT_SEEN_MAX,
  ) {
    const anchor = primeHitAnchor(prime);
    this.watermarkMs = anchor.watermarkMs;
    const times = new Map(
      prime.data.map((hit) => [hit.id, Date.parse(hit.occurred_at)]),
    );
    for (const id of anchor.seenIds) this.remember(id, times.get(id));

    // The prime page is our only record of what existed before the tail
    // started. If it was cut off, hits older than its last row are unknown to
    // us, so never re-read past that row: they would print as new arrivals.
    const oldest = Math.min(
      ...[...times.values()].filter((ms) => Number.isFinite(ms)),
    );
    this.floorMs =
      prime.next_cursor && Number.isFinite(oldest) ? Math.max(0, oldest - 1) : 0;
  }

  /** Exclusive lower bound for the next poll. */
  since(): string {
    return new Date(
      Math.max(0, this.floorMs, this.watermarkMs - this.overlapMs),
    ).toISOString();
  }

  /**
   * Fold one poll's hits (newest first, as the API returns them) into the
   * tail. Returns the ones not seen before, oldest first.
   */
  accept<T extends TailHit>(hits: T[]): T[] {
    const fresh: T[] = [];
    for (let i = hits.length - 1; i >= 0; i--) {
      const hit = hits[i]!;
      const ms = Date.parse(hit.occurred_at);
      if (Number.isFinite(ms) && ms > this.watermarkMs) this.watermarkMs = ms;
      if (this.seen.has(hit.id)) continue;
      this.remember(hit.id, ms);
      fresh.push(hit);
    }
    this.prune();
    return fresh;
  }

  private remember(id: string, ms: number | undefined): void {
    this.seen.set(
      id,
      ms !== undefined && Number.isFinite(ms) ? ms : this.watermarkMs,
    );
  }

  private prune(): void {
    const cutoff = Date.parse(this.since()) - PRUNE_SLACK_MS;
    for (const [id, ms] of this.seen) {
      if (ms < cutoff) this.seen.delete(id);
    }
    // Backstop for a feed busy enough to overflow the window: forget the
    // oldest ids first. That can re-print a hit; it cannot lose one.
    for (const id of this.seen.keys()) {
      if (this.seen.size <= this.seenMax) break;
      this.seen.delete(id);
    }
  }
}
