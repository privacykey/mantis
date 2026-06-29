"use client";

import { useEffect, useRef, useState } from "react";
import type { HostContext } from "@/lib/installers/headers";
import { relativeTime } from "@/lib/ui";

// Live-updating hit feed. Polls the existing /api/hits/recent endpoint (which
// supports key_id + an ISO `since` watermark) on a short interval and prepends
// new hits. Chosen over WebSocket/SSE deliberately: canary hits are rare, the
// endpoint + index already exist, polling needs no persistent connection (so it
// survives the tunnel sidecars and multi-replica deploys), and it mirrors the
// CLI's `mantis hits --follow` cadence. See the hits-feed design notes in the PR.

const POLL_MS = 3000;
const PAGE_LIMIT = 100;
const MAX_ROWS = 300; // bound the DOM; older rows drop off the bottom
const HIGHLIGHT_MS = 2500;

type HitNotif = {
  id: string;
  channel: string;
  target: string;
  status: string;
  attempts: number;
  max_attempts: number;
  next_attempt_at: string | null;
  succeeded_at: string | null;
  last_error: string | null;
};

type Hit = {
  id: string;
  occurred_at: string;
  ip: string | null;
  user_agent: string | null;
  referer: string | null;
  headers: Record<string, string> | null;
  ua_browser: string | null;
  ua_browser_version: string | null;
  ua_os: string | null;
  ua_device: string | null;
  bot_label: string | null;
  is_duplicate: boolean;
  host_context: HostContext | null;
  notifications: HitNotif[];
};

export function HitsFeed({
  keyId,
  dedupeWindowSeconds,
}: {
  keyId: string;
  dedupeWindowSeconds: number;
}) {
  const [hits, setHits] = useState<Hit[] | null>(null); // null = initial loading
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState(true);
  const [freshIds, setFreshIds] = useState<Set<string>>(new Set());

  const seen = useRef<Set<string>>(new Set());
  const since = useRef<string | null>(null); // newest occurred_at ingested
  const liveRef = useRef(live);
  liveRef.current = live;

  async function load(sinceArg: string | null): Promise<Hit[]> {
    const qs = new URLSearchParams({ key_id: keyId, limit: String(PAGE_LIMIT) });
    if (sinceArg) qs.set("since", sinceArg);
    const res = await fetch(`/api/hits/recent?${qs.toString()}`, {
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = (await res.json()) as { data: Hit[] };
    return json.data;
  }

  function markFresh(ids: string[]) {
    setFreshIds((prev) => {
      const next = new Set(prev);
      for (const id of ids) next.add(id);
      return next;
    });
    window.setTimeout(() => {
      setFreshIds((prev) => {
        const next = new Set(prev);
        for (const id of ids) next.delete(id);
        return next;
      });
    }, HIGHLIGHT_MS);
  }

  useEffect(() => {
    let stop = false;
    let timer: number | undefined;

    const schedule = () => {
      timer = window.setTimeout(tick, POLL_MS);
    };

    const tick = async () => {
      if (stop) return;
      if (document.hidden || !liveRef.current) {
        schedule();
        return;
      }
      try {
        const data = await load(since.current);
        const fresh = data.filter((h) => !seen.current.has(h.id));
        if (fresh.length > 0) {
          for (const h of fresh) seen.current.add(h.id);
          since.current = fresh[0]!.occurred_at; // API is desc → newest first
          setHits((prev) => [...fresh, ...(prev ?? [])].slice(0, MAX_ROWS));
          markFresh(fresh.map((h) => h.id));
        }
        setError(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
      if (!stop) schedule();
    };

    // Initial load, then start polling.
    (async () => {
      try {
        const data = await load(null);
        for (const h of data) seen.current.add(h.id);
        since.current = data[0]?.occurred_at ?? null;
        setHits(data);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setHits([]);
      }
      if (!stop) schedule();
    })();

    // Refresh promptly when the tab regains focus instead of waiting a full tick.
    const onVisible = () => {
      if (!document.hidden && liveRef.current && !stop) {
        window.clearTimeout(timer);
        void tick();
      }
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      stop = true;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [keyId]);

  return (
    <section className="mt-8">
      <div className="flex items-baseline justify-between mb-3">
        <div className="flex items-baseline gap-2">
          <h2 className="text-base font-semibold">hits</h2>
          <LiveIndicator
            live={live}
            loading={hits === null}
            onToggle={() => setLive((v) => !v)}
          />
        </div>
        <span className="text-xs text-neutral-500">
          {hits === null
            ? "loading…"
            : hits.length >= MAX_ROWS
              ? `latest ${MAX_ROWS}`
              : `${hits.length} shown`}
        </span>
      </div>

      {error && (
        <p className="text-xs text-amber-500 mb-3">
          live updates paused — {error} (retrying…)
        </p>
      )}

      {hits !== null && hits.length > 0 && (
        <p className="text-xs text-neutral-600 mb-3 leading-relaxed">
          <span
            className="text-neutral-500"
            title={
              dedupeWindowSeconds === 0
                ? "Repeat hit (deduplication is off, so these still notify)"
                : `Repeat hit within the ${dedupeWindowSeconds}s dedupe window`
            }
          >
            dup
          </span>{" "}
          = repeat hit inside the dedupe window
          {dedupeWindowSeconds === 0 ? " (off)" : ` (${dedupeWindowSeconds}s)`}
          {"; "}
          <span
            className="text-neutral-500"
            title="Notifications were skipped because this hit was a duplicate"
          >
            suppressed
          </span>{" "}
          = notifications skipped for that duplicate;{" "}
          <span
            className="text-amber-500"
            title="Request matched a known crawler or bot user-agent"
          >
            bot
          </span>{" "}
          = matched a known crawler/bot.
        </p>
      )}

      {hits === null ? (
        <div className="text-center py-12 text-neutral-600 border border-dashed border-neutral-900 rounded">
          loading hits…
        </div>
      ) : hits.length === 0 ? (
        <div className="text-center py-12 text-neutral-500 border border-dashed border-neutral-900 rounded">
          no hits yet. fetch the URL above to trigger one — new hits appear here
          live.
        </div>
      ) : (
        <div className="space-y-1.5">
          {hits.map((h) => (
            <HitRow key={h.id} hit={h} fresh={freshIds.has(h.id)} />
          ))}
        </div>
      )}
    </section>
  );
}

function LiveIndicator({
  live,
  loading,
  onToggle,
}: {
  live: boolean;
  loading: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      title={live ? "Live — click to pause" : "Paused — click to resume"}
      className="inline-flex items-center gap-1.5 text-xs text-neutral-500 hover:text-neutral-300 cursor-pointer font-[inherit] bg-transparent border-0 p-0"
    >
      <span
        className={`inline-block w-2 h-2 rounded-full ${
          loading
            ? "bg-neutral-600"
            : live
              ? "bg-emerald-500 animate-pulse"
              : "bg-neutral-600"
        }`}
        aria-hidden="true"
      />
      {live ? "live" : "paused"}
    </button>
  );
}

function HitRow({ hit, fresh }: { hit: Hit; fresh: boolean }) {
  const headers = hit.headers ?? {};
  const ctx = hit.host_context;
  return (
    <details
      className={`border rounded bg-neutral-950 overflow-hidden transition-colors duration-1000 ${
        fresh ? "border-emerald-700 bg-emerald-950/30" : "border-neutral-900"
      }`}
    >
      <summary className="px-3 py-2 cursor-pointer flex items-center gap-3 text-sm hover:bg-neutral-900/50">
        <span className="text-neutral-500 text-xs w-20 shrink-0">
          {relativeTime(hit.occurred_at)}
        </span>
        <span className="font-mono text-neutral-300 w-32 shrink-0">
          {hit.ip ?? "—"}
        </span>
        <span className="text-neutral-400 truncate flex-1">
          {ctx ? <HostContextChip ctx={ctx} /> : formatUaLabel(hit)}
        </span>
        {hit.bot_label && !ctx && (
          <span className="text-amber-500 text-xs shrink-0 bg-amber-950/40 px-1.5 py-0.5 rounded">
            {hit.bot_label}
          </span>
        )}
        {hit.is_duplicate && (
          <span className="text-neutral-500 text-xs shrink-0 bg-neutral-900 px-1.5 py-0.5 rounded">
            dup
          </span>
        )}
        <NotifySummary notifs={hit.notifications} isDup={hit.is_duplicate} />
      </summary>
      <div className="px-3 pb-3 pt-1 border-t border-neutral-900 text-xs space-y-3">
        {ctx && (
          <div className="bg-emerald-950/30 border border-emerald-950 rounded p-2">
            <div className="text-emerald-400 text-xs mb-1 uppercase tracking-wide">
              host event ({ctx.source ?? "unknown"})
            </div>
            <div className="space-y-0.5">
              {ctx.event && <Row k="event" v={ctx.event} className="text-emerald-300" />}
              {ctx.device && <Row k="device" v={ctx.device} />}
              {ctx.entity_id && <Row k="entity" v={ctx.entity_id} />}
              {ctx.automation && <Row k="automation" v={ctx.automation} />}
              {ctx.area && <Row k="area" v={ctx.area} />}
              {ctx.user && <Row k="user" v={ctx.user} />}
              {ctx.host && <Row k="host" v={ctx.host} />}
              {ctx.ssh_client_ip && (
                <Row k="ssh from" v={ctx.ssh_client_ip} className="text-amber-300" />
              )}
              {ctx.ssh_connection && <Row k="ssh full" v={ctx.ssh_connection} />}
              {ctx.tty && <Row k="tty" v={ctx.tty} />}
              {ctx.sudo_cmd && (
                <Row k="sudo cmd" v={ctx.sudo_cmd} className="text-amber-300" />
              )}
              {ctx.network_interface && (
                <Row k="interface" v={ctx.network_interface} />
              )}
              {ctx.iot_mac && <Row k="mac" v={ctx.iot_mac} />}
              {ctx.iot_ip && <Row k="iot ip" v={ctx.iot_ip} />}
            </div>
          </div>
        )}

        <div>
          <Row k="when" v={hit.occurred_at} />
          <Row k="ip" v={hit.ip ?? "—"} />
          <Row
            k="ua"
            v={
              hit.ua_browser
                ? `${hit.ua_browser} ${hit.ua_browser_version ?? ""} on ${hit.ua_os ?? "?"} (${hit.ua_device ?? "?"})`
                : (hit.user_agent ?? "—")
            }
          />
          {hit.bot_label && <Row k="bot" v={hit.bot_label} className="text-amber-400" />}
          <Row k="referer" v={hit.referer ?? "—"} />
        </div>

        {hit.notifications.length > 0 && (
          <div>
            <div className="text-neutral-500 mb-1">notifications</div>
            <div className="space-y-1">
              {hit.notifications.map((n) => (
                <NotifLine key={n.id} n={n} />
              ))}
            </div>
          </div>
        )}

        <div>
          <div className="text-neutral-500 mb-1">request headers</div>
          <pre className="bg-neutral-950 border border-neutral-900 rounded p-2 overflow-auto max-h-48 text-neutral-400">
            {Object.entries(headers)
              .map(([k, v]) => `${k}: ${v}`)
              .join("\n")}
          </pre>
        </div>
      </div>
    </details>
  );
}

function HostContextChip({ ctx }: { ctx: HostContext }) {
  const parts: string[] = [];
  if (ctx.source) parts.push(ctx.source);
  if (ctx.user) parts.push(ctx.user);
  if (ctx.host) parts.push(`@ ${ctx.host}`);
  if (ctx.ssh_client_ip) parts.push(`← ${ctx.ssh_client_ip}`);
  if (ctx.sudo_cmd) parts.push(`sudo ${ctx.sudo_cmd}`);
  if (ctx.network_interface) parts.push(`iface=${ctx.network_interface}`);
  if (ctx.event) parts.push(ctx.event);
  if (ctx.device) parts.push(ctx.device);
  if (ctx.entity_id) parts.push(ctx.entity_id);
  if (ctx.iot_mac) parts.push(ctx.iot_mac);
  return <span className="text-emerald-400">{parts.join(" · ")}</span>;
}

function NotifLine({ n }: { n: HitNotif }) {
  const colorClass =
    n.status === "succeeded"
      ? "text-emerald-400"
      : n.status === "failed"
        ? "text-red-400"
        : n.status === "aborted"
          ? "text-neutral-500"
          : n.status === "in_flight"
            ? "text-blue-400"
            : "text-amber-400";
  return (
    <div className="flex items-start gap-3">
      <span className={`${colorClass} w-20 shrink-0`}>{n.status}</span>
      <span className="text-neutral-400 w-16 shrink-0">{n.channel}</span>
      <span className="text-neutral-300 break-all flex-1 min-w-0">
        {n.target}
        {n.attempts > 0 && (
          <span className="text-neutral-500 ml-1">
            ({n.attempts}/{n.max_attempts} attempts
            {n.status === "pending" && n.next_attempt_at
              ? `, next ${relativeTime(n.next_attempt_at)}`
              : ""}
            )
          </span>
        )}
        {n.last_error && (
          <div className="text-red-400 mt-0.5 break-words">{n.last_error}</div>
        )}
      </span>
    </div>
  );
}

function NotifySummary({
  notifs,
  isDup,
}: {
  notifs: HitNotif[];
  isDup: boolean;
}) {
  if (isDup) {
    return <span className="text-neutral-600 text-xs shrink-0">suppressed</span>;
  }
  if (notifs.length === 0) {
    return <span className="text-neutral-600 text-xs shrink-0">—</span>;
  }
  const succeeded = notifs.filter((n) => n.status === "succeeded").length;
  const failed = notifs.filter((n) => n.status === "failed").length;
  const pending = notifs.filter(
    (n) => n.status === "pending" || n.status === "in_flight",
  ).length;
  return (
    <span className="text-xs shrink-0 flex gap-1">
      {succeeded > 0 && (
        <span className="text-emerald-500">
          <span aria-hidden="true">✓</span>
          {succeeded}
          <span className="sr-only"> succeeded</span>
        </span>
      )}
      {pending > 0 && (
        <span className="text-amber-400">
          <span aria-hidden="true">⏳</span>
          {pending}
          <span className="sr-only"> pending</span>
        </span>
      )}
      {failed > 0 && (
        <span className="text-red-400">
          <span aria-hidden="true">⚠</span>
          {failed}
          <span className="sr-only"> failed</span>
        </span>
      )}
    </span>
  );
}

function formatUaLabel(hit: Hit): string {
  if (hit.ua_browser) {
    return `${hit.ua_browser}${hit.ua_browser_version ? ` ${hit.ua_browser_version}` : ""} · ${hit.ua_os ?? "?"}`;
  }
  return hit.user_agent ?? "no UA";
}

function Row({
  k,
  v,
  className,
}: {
  k: string;
  v: string;
  className?: string;
}) {
  return (
    <div className="flex gap-3 py-0.5">
      <span className="text-neutral-500 w-20 shrink-0">{k}</span>
      <span className={`text-neutral-300 break-all ${className ?? ""}`}>{v}</span>
    </div>
  );
}
