import { ApiError, type Key, type MantisClient } from "./api.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PREFIX_RE = /^[0-9a-f]{4,}$/i;

export class ResolveError extends Error {}

/**
 * Turn a user-typed key reference into a full UUID.
 *
 * Accepted forms:
 *   - full UUID (passed through, lower-cased)
 *   - `last` — most-recently-created key
 *   - prefix of UUID (≥4 hex chars) — disambiguates against recent keys
 *
 * Falls back to a server round-trip only when needed; full UUIDs and "last"
 * always cost at most one extra call.
 */
export async function resolveKeyRef(
  client: MantisClient,
  ref: string,
): Promise<string> {
  if (!ref || typeof ref !== "string") {
    throw new ResolveError("missing key reference");
  }

  if (UUID_RE.test(ref)) return ref.toLowerCase();

  if (ref === "last") {
    const page = await client.listKeys({ limit: 1 });
    if (page.data.length === 0) {
      throw new ResolveError(
        "`last` — no keys exist yet. Run `mantis new \"memo\"` to create one.",
      );
    }
    return page.data[0]!.id;
  }

  if (!PREFIX_RE.test(ref)) {
    throw new ResolveError(
      `not a valid key id, prefix, or "last": ${ref}`,
    );
  }

  // Prefix lookup — pull a generous window of recent keys and filter.
  const pool: Key[] = [];
  let cursor: string | undefined;
  let fetched = 0;
  const MAX_FETCH = 1000;
  do {
    const page = await client.listKeys({ limit: 200, cursor });
    pool.push(...page.data);
    fetched += page.data.length;
    cursor = page.next_cursor ?? undefined;
  } while (cursor && fetched < MAX_FETCH);

  const lower = ref.toLowerCase();
  const matches = pool.filter((k) => k.id.startsWith(lower));

  if (matches.length === 0) {
    throw new ResolveError(
      `no key matches prefix '${ref}'. Run \`mantis list\` to see configured keys.`,
    );
  }
  if (matches.length > 1) {
    const sample = matches
      .slice(0, 5)
      .map((k) => `  ${k.id.slice(0, 12)}… — ${k.memo}`)
      .join("\n");
    const extra =
      matches.length > 5
        ? `\n  …and ${matches.length - 5} more`
        : "";
    throw new ResolveError(
      `prefix '${ref}' is ambiguous (${matches.length} matches):\n${sample}${extra}`,
    );
  }
  return matches[0]!.id;
}

/** Same as resolveKeyRef, but returns null instead of throwing if input is undefined. */
export async function resolveOptional(
  client: MantisClient,
  ref: string | undefined,
): Promise<string | null> {
  if (!ref) return null;
  return resolveKeyRef(client, ref);
}

/**
 * Convert a server 404 into a helpful "not found / typo'd id" error.
 * Useful right after resolveKeyRef when the server returns 404 on getKey.
 */
export function wrapNotFound(err: unknown): never {
  if (err instanceof ApiError && err.status === 404) {
    throw new ResolveError(
      "key not found. Run `mantis list` to see configured keys.",
    );
  }
  throw err;
}
