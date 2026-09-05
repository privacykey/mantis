import { ExitCode, fail } from "./out.js";

// Node resets delays above this limit to 1 ms instead of waiting longer.
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/** Parse seconds for polling, preserving the existing one-second minimum. */
export function parseIntervalMs(raw: string | undefined, fallback: number): number {
  const seconds = Number(raw ?? fallback);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    fail(
      `--interval must be a positive finite number of seconds (got ${raw})`,
      ExitCode.Usage,
    );
  }
  const ms = seconds * 1000;
  if (ms > MAX_TIMER_DELAY_MS) {
    fail(
      `--interval must be at most ${MAX_TIMER_DELAY_MS / 1000} seconds (got ${raw})`,
      ExitCode.Usage,
    );
  }
  return Math.max(1000, ms);
}

/**
 * Validate a numeric `--limit` flag. Shared by `list`, `hits`, and `status` so
 * a bad value (`--limit abc`, `--limit -5`, `--limit 0`) fails the same way
 * everywhere instead of silently coercing to NaN / a negative page size.
 *
 * `raw` is the flag string as commander passes it (often a default like "50").
 * When it's undefined/empty the caller's `fallback` is returned unchanged, so
 * existing default behavior is preserved. A positive integer at or below `max`
 * (when given) passes through; anything else exits via fail() with a clear
 * usage message.
 */
export function parseLimit(
  raw: string | undefined,
  opts: { fallback?: number; max?: number } = {},
): number {
  const fallback = opts.fallback ?? 50;
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    fail(`--limit must be a positive integer (got ${raw})`, ExitCode.Usage);
  }
  if (opts.max !== undefined && n > opts.max) {
    fail(`--limit must be at most ${opts.max} (got ${raw})`, ExitCode.Usage);
  }
  return n;
}
