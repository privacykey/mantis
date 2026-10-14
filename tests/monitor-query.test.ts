import { beforeEach, describe, expect, it, vi } from "vitest";

// The latest-hit lookup behind /status and /api/keys/:id/monitor must be
// served by hits_key_occurred_idx (key_id, occurred_at DESC NULLS LAST). A bare
// `ORDER BY occurred_at DESC` means NULLS FIRST in Postgres, which that index
// cannot supply: on PG 18 the planner then reads every matching hit and sorts
// (measured: 200k hits → seq scan + top-N sort; with NULLS LAST → one index
// probe). This pins the SQL that drizzle actually renders.

const captured = vi.hoisted(() => ({ sql: [] as string[] }));

vi.mock("@/db/client", async () => {
  const { drizzle } = await import("drizzle-orm/pg-proxy");
  return {
    db: drizzle(async (sql: string) => {
      captured.sql.push(sql);
      return { rows: [] };
    }),
  };
});

import type { Key } from "@/db/schema";
import { computeMonitorState } from "@/lib/monitor";

const key = {
  id: "00000000-0000-4000-8000-000000000001",
  monitorMode: "latch",
  monitorWindowSeconds: 300,
  monitorResetAt: null,
  disabledAt: null,
  expiresAt: null,
} as Key;

beforeEach(() => {
  captured.sql = [];
});

describe("computeMonitorState latest-hit query", () => {
  it.each([
    ["latch", key],
    ["latch after a reset", { ...key, monitorResetAt: new Date() }],
    ["window", { ...key, monitorMode: "window" }],
  ] as const)("orders %s lookups the way the hits index is built", async (_mode, k) => {
    expect(await computeMonitorState(k as Key)).toEqual({ kind: "ok" });
    expect(captured.sql).toHaveLength(1);
    expect(captured.sql[0]).toMatch(/order by "hits"\."occurred_at" desc nulls last limit \$\d+$/i);
  });

  it("does not query at all for a key whose monitor is off", async () => {
    expect(await computeMonitorState({ ...key, monitorMode: "off" } as Key)).toEqual({ kind: "off" });
    expect(captured.sql).toEqual([]);
  });
});
