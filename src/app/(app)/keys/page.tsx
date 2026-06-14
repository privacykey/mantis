import { desc, eq, sql } from "drizzle-orm";
import { redirect } from "next/navigation";
import Link from "next/link";
import { db } from "@/db/client";
import { hits, keys } from "@/db/schema";
import { keyUrl } from "@/lib/env";
import { getSessionApiKey } from "@/lib/session";
import { relativeTime, truncate } from "@/lib/ui";
import { toggleKeyAction } from "./actions";

export const dynamic = "force-dynamic";

// Newest-N shown in the dashboard; older keys remain reachable via the API.
const KEYS_PAGE_SIZE = 200;

export default async function KeysPage() {
  const session = await getSessionApiKey();
  if (!session) redirect("/login");

  // Non-admin sessions only see keys they own. Admins see everything.
  const where = session.isAdmin
    ? undefined
    : eq(keys.createdByApiKeyId, session.id);

  // Bound the work: take a page of the newest keys FIRST, then aggregate hits
  // only for those. The old query joined every key against the entire hits
  // table with no limit, so the per-key count/max scanned all hits on every
  // dashboard load — cost grew with total hits, unbounded. This caps it to
  // the hits belonging to one page of keys (served by hits_key_occurred_idx).
  const pageKeys = db
    .select({
      id: keys.id,
      publicId: keys.publicId,
      memo: keys.memo,
      createdAt: keys.createdAt,
      disabledAt: keys.disabledAt,
    })
    .from(keys)
    .where(where)
    .orderBy(desc(keys.createdAt))
    .limit(KEYS_PAGE_SIZE)
    .as("page_keys");

  const rows = await db
    .select({
      id: pageKeys.id,
      publicId: pageKeys.publicId,
      memo: pageKeys.memo,
      createdAt: pageKeys.createdAt,
      disabledAt: pageKeys.disabledAt,
      hitCount: sql<number>`count(${hits.id})::int`.as("hit_count"),
      lastHit: sql<Date | null>`max(${hits.occurredAt})`.as("last_hit"),
    })
    .from(pageKeys)
    .leftJoin(hits, eq(hits.keyId, pageKeys.id))
    .groupBy(
      pageKeys.id,
      pageKeys.publicId,
      pageKeys.memo,
      pageKeys.createdAt,
      pageKeys.disabledAt,
    )
    .orderBy(desc(pageKeys.createdAt));

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-xl font-semibold">keys</h1>
        <Link
          href="/keys/new"
          className="bg-neutral-100 text-neutral-900 rounded px-3 py-1.5 text-sm font-medium no-underline hover:bg-white"
        >
          + new key
        </Link>
      </div>

      {rows.length === 0 ? (
        <div className="text-center py-16 text-neutral-500">
          <p className="mb-3">no keys yet</p>
          <Link
            href="/keys/new"
            className="text-blue-400 no-underline hover:underline"
          >
            create your first one →
          </Link>
        </div>
      ) : (
        <>
        <div className="border border-neutral-900 rounded overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-neutral-950 text-neutral-500 text-xs uppercase tracking-wide">
              <tr>
                <th className="text-left px-3 py-2 font-medium">memo</th>
                <th className="text-left px-3 py-2 font-medium">hits</th>
                <th className="text-left px-3 py-2 font-medium">last seen</th>
                <th className="text-left px-3 py-2 font-medium">status</th>
                <th className="text-right px-3 py-2 font-medium">actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const disabled = r.disabledAt !== null;
                return (
                  <tr
                    key={r.id}
                    className="border-t border-neutral-900 hover:bg-neutral-950"
                  >
                    <td className="px-3 py-2">
                      <Link
                        href={`/keys/${r.id}`}
                        className="text-neutral-200 no-underline hover:underline"
                      >
                        {truncate(r.memo, 60)}
                      </Link>
                      <div className="text-xs text-neutral-600 mt-0.5 font-mono">
                        {keyUrl(r.publicId)}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-neutral-300 tabular-nums">
                      {r.hitCount}
                    </td>
                    <td className="px-3 py-2 text-neutral-400">
                      {relativeTime(r.lastHit)}
                    </td>
                    <td className="px-3 py-2">
                      {disabled ? (
                        <span className="text-red-400 text-xs">disabled</span>
                      ) : (
                        <span className="text-emerald-400 text-xs">active</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <form action={toggleKeyAction} className="inline">
                        <input type="hidden" name="id" value={r.id} />
                        <input
                          type="hidden"
                          name="disable"
                          value={disabled ? "0" : "1"}
                        />
                        <button
                          type="submit"
                          className="text-xs text-neutral-500 hover:text-neutral-200 bg-transparent border-0 cursor-pointer font-[inherit] p-0"
                        >
                          {disabled ? "enable" : "disable"}
                        </button>
                      </form>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {rows.length === KEYS_PAGE_SIZE && (
          <p className="text-xs text-neutral-600 mt-3">
            showing the {KEYS_PAGE_SIZE} most recent keys — use{" "}
            <code className="font-mono">GET /api/keys</code> to page through the
            rest.
          </p>
        )}
        </>
      )}
    </div>
  );
}
