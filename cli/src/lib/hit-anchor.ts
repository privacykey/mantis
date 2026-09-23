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
