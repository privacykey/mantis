import { ApiError, type Key, type MantisClient } from "./api.js";
import { c, isJsonMode, jsonText, safeText } from "./out.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PREFIX_RE = /^[0-9a-f]{4,}$/i;

export class ResolveError extends Error {}

export type ResolvedKeyRef = {
  id: string;
  /**
   * The key a symbolic ref (`last` or a prefix) resolved to. Absent for a
   * full UUID, which is passed through without a lookup.
   */
  key?: Key;
};

/**
 * Turn a user-typed key reference into a full UUID.
 *
 * Accepted forms:
 *   - full UUID (passed through, lower-cased)
 *   - `last` — the key this credential created most recently
 *   - prefix of UUID (≥4 hex chars) — disambiguates against recent keys
 *
 * Falls back to a server round-trip only when needed; full UUIDs and "last"
 * always cost at most one extra call.
 */
export async function resolveKeyRef(
  client: MantisClient,
  ref: string,
): Promise<string> {
  return (await resolveKeyRefDetailed(client, ref)).id;
}

/**
 * resolveKeyRef for commands that change, fire or export a key. A symbolic
 * ref is resolved afresh on every run, so the operator is told which key it
 * picked — id and memo, on stderr — before the command acts on it.
 */
export async function resolveKeyRefForAction(
  client: MantisClient,
  ref: string,
): Promise<string> {
  const resolved = await resolveKeyRefDetailed(client, ref);
  if (resolved.key) announceResolved(ref, resolved.key);
  return resolved.id;
}

/** Say which key a symbolic ref resolved to. Stderr, so stdout stays clean. */
export function announceResolved(ref: string, key: Key): void {
  if (isJsonMode()) {
    process.stderr.write(
      jsonText({ resolved: { ref, id: key.id, memo: key.memo } }) + "\n",
    );
    return;
  }
  process.stderr.write(
    c.dim(`${safeText(ref)} → ${safeText(key.id)} (${safeText(key.memo)})\n`),
  );
}

/** resolveKeyRef, also returning the key a symbolic ref resolved to. */
export async function resolveKeyRefDetailed(
  client: MantisClient,
  ref: string,
): Promise<ResolvedKeyRef> {
  if (!ref || typeof ref !== "string") {
    throw new ResolveError("missing key reference");
  }

  if (UUID_RE.test(ref)) return { id: ref.toLowerCase() };

  if (ref === "last") {
    // `mine` scopes the listing to keys this credential created. Without it
    // an admin's listing spans every creator — fleet enroll keys included —
    // so somebody else's newer key would stand in for the operator's own.
    const page = await client.listKeys({ limit: 1, mine: 1 });
    if (page.data.length === 0) {
      throw new ResolveError(
        "`last` — this API key has not created any keys yet (keys made in the dashboard or with another API key don't count). Run `mantis new \"memo\"`, or pass a key id or prefix from `mantis list`.",
      );
    }
    const key = page.data[0]!;
    return { id: key.id, key };
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
    // Memos are written by whoever created each key; keep them on one line.
    const sample = matches
      .slice(0, 5)
      .map((k) => `  ${safeText(k.id).slice(0, 12)}… — ${safeText(k.memo)}`)
      .join("\n");
    const extra =
      matches.length > 5
        ? `\n  …and ${matches.length - 5} more`
        : "";
    throw new ResolveError(
      `prefix '${ref}' is ambiguous (${matches.length} matches):\n${sample}${extra}`,
    );
  }
  const key = matches[0]!;
  return { id: key.id, key };
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
