import { desc, eq, inArray } from "drizzle-orm";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { db } from "@/db/client";
import {
  hits,
  notifications,
  keys,
  type Hit,
  type Notification,
} from "@/db/schema";
import { canAccessKey } from "@/lib/auth";
import { statusUrl as buildStatusUrl, keyUrl } from "@/lib/env";
import { isApplePassEnabled } from "@/lib/installers/apple-wallet";
import {
  parseHostContext,
  type HostContext,
} from "@/lib/installers/headers";
import {
  fingerprintSecret,
  listDestinations,
} from "@/lib/notify/destinations";
import { computeMonitorState } from "@/lib/monitor";
import { getSessionApiKey } from "@/lib/session";
import { relativeTime } from "@/lib/ui";
import { toggleKeyAction } from "../actions";
import { CopyUrl } from "./copy-url";
import { DeleteButton } from "./delete-button";
import { InstallersCard } from "./installers";
import { MonitorCard } from "./monitor-card";
import { SecretReveal } from "./secret-reveal";

export const dynamic = "force-dynamic";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Props = { params: Promise<{ id: string }> };

export default async function KeyDetailPage({ params }: Props) {
  const session = await getSessionApiKey();
  if (!session) redirect("/login");

  const { id } = await params;
  if (!UUID_RE.test(id)) notFound();

  const [key] = await db.select().from(keys).where(eq(keys.id, id)).limit(1);
  if (!key || !canAccessKey(session, key)) notFound();

  const recent = await db
    .select()
    .from(hits)
    .where(eq(hits.keyId, id))
    .orderBy(desc(hits.occurredAt))
    .limit(100);

  const hitIds = recent.map((h) => h.id);
  const notifs =
    hitIds.length > 0
      ? await db
          .select()
          .from(notifications)
          .where(inArray(notifications.hitId, hitIds))
      : [];

  const notifsByHit = new Map<string, Notification[]>();
  for (const n of notifs) {
    const arr = notifsByHit.get(n.hitId);
    if (arr) arr.push(n);
    else notifsByHit.set(n.hitId, [n]);
  }

  const url = keyUrl(key.publicId);
  const monitorState = await computeMonitorState(key);
  const disabled = key.disabledAt !== null;
  const destinations = await listDestinations(key.id);
  const applePassEnabled = await isApplePassEnabled();

  return (
    <div>
      <div className="mb-4">
        <Link
          href="/keys"
          className="text-xs text-neutral-500 no-underline hover:text-neutral-300"
        >
          ← all keys
        </Link>
      </div>

      <div className="flex items-start justify-between gap-4 mb-6">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold truncate">{key.memo}</h1>
          <p className="text-xs text-neutral-600 mt-1 font-mono">{key.id}</p>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          {disabled ? (
            <span className="text-red-400 text-xs px-2 py-1 bg-red-950/40 rounded">
              disabled
            </span>
          ) : (
            <span className="text-emerald-400 text-xs px-2 py-1 bg-emerald-950/40 rounded">
              active
            </span>
          )}
          <form action={toggleKeyAction}>
            <input type="hidden" name="id" value={key.id} />
            <input
              type="hidden"
              name="disable"
              value={disabled ? "0" : "1"}
            />
            <button type="submit" className={btnSecondary}>
              {disabled ? "enable" : "disable"}
            </button>
          </form>
          <DeleteButton keyId={key.id} memo={key.memo} />
        </div>
      </div>

      <section className="grid sm:grid-cols-2 gap-4 mb-8">
        <Card title="mantis URL">
          <CopyUrl url={url} />
          <div className="mt-3 pt-3 border-t border-neutral-900 text-xs text-neutral-500">
            <span className="block mb-1">file keys</span>
            <div className="flex flex-wrap gap-3">
              {(["docx", "xlsx", "pptx", "pdf"] as const).map((fmt) => (
                <a
                  key={fmt}
                  href={`/api/keys/${key.id}/download?format=${fmt}`}
                  className="text-blue-400 no-underline hover:underline"
                  download
                >
                  ↓ .{fmt}
                </a>
              ))}
            </div>
            <span className="block mt-2 mb-1">self-hosted app formats</span>
            <div className="flex flex-wrap gap-3">
              {(["svg", "html", "md", "eml", "ics", "vcf"] as const).map((fmt) => (
                <a
                  key={fmt}
                  href={`/api/keys/${key.id}/download?format=${fmt}`}
                  className="text-blue-400 no-underline hover:underline"
                  download
                >
                  ↓ .{fmt}
                </a>
              ))}
            </div>
            <span className="block text-neutral-600 mt-1">
              for Immich / Paperless / Joplin / calendar / contacts etc. — see <code>self-hosted-apps.md</code>.
            </span>
            <span className="block mt-2 mb-1">honey directory (zip)</span>
            <a
              href={`/api/keys/${key.id}/download?format=folder`}
              className="text-blue-400 no-underline hover:underline"
              download
            >
              ↓ folder.zip
            </a>
            <span className="block text-neutral-600 mt-1">
              bundle of pre-baited Office docs + PDF + fake-credentials .txt + Win/.url + macOS/.webloc shortcuts. Drop on a shared drive; any file fires this key.
            </span>
            {applePassEnabled && (
              <>
                <span className="block mt-3 mb-1">Apple Wallet pass</span>
                <a
                  href={`/api/keys/${key.id}/download?format=apple-wallet`}
                  className="text-blue-400 no-underline hover:underline"
                  download
                >
                  ↓ .pkpass
                </a>
                <span className="block text-neutral-600 mt-1">
                  Signed Apple Wallet pass. Airdrop or email to a target;
                  fires on install/uninstall via Wallet's web service callbacks.
                </span>
              </>
            )}
          </div>
        </Card>
        <Card title="trigger response">
          <p className="text-sm text-neutral-300">{key.responseKind}</p>
          {key.responsePayload != null && (
            <pre className="text-xs text-neutral-400 mt-1 overflow-auto max-h-32 bg-neutral-950 p-2 rounded border border-neutral-900">
              {JSON.stringify(key.responsePayload, null, 2)}
            </pre>
          )}
        </Card>
        <Card title="notification destinations">
          {destinations.length === 0 ? (
            <p className="text-sm text-neutral-600">none configured</p>
          ) : (
            <ul className="space-y-2">
              {destinations.map((d) => {
                const status = d.lastActivationStatus;
                const icon =
                  status === "ok"
                    ? <span className="text-emerald-400">✓</span>
                    : status === "failed"
                    ? <span className="text-red-400">⚠</span>
                    : <span className="text-neutral-600">·</span>;
                return (
                  <li key={d.id} className="flex items-start gap-2 text-sm">
                    <span className="shrink-0 w-3">{icon}</span>
                    <span className="shrink-0 text-neutral-500 text-xs uppercase tracking-wide w-16">
                      {d.channel}
                    </span>
                    <span className="text-neutral-300 break-all flex-1 font-mono text-xs">
                      {d.target}
                      {status === "failed" && d.lastActivationError && (
                        <span className="block text-red-400 mt-0.5 not-font-mono">
                          activation failed: {d.lastActivationError}
                        </span>
                      )}
                      {d.channel === "webhook" && d.signingSecret && (
                        <SecretReveal
                          keyId={key.id}
                          destinationId={d.id}
                          fingerprint={fingerprintSecret(d.signingSecret)}
                        />
                      )}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
        <Card title="dedupe window">
          <p className="text-sm text-neutral-300">
            {key.dedupeWindowSeconds === 0
              ? "off"
              : `${key.dedupeWindowSeconds}s`}
          </p>
          <p className="text-xs text-neutral-600 mt-1">
            Repeat hits within this window are recorded but don't notify.
          </p>
        </Card>
      </section>

      <InstallersCard keyId={key.id} />

      <MonitorCard
        keyId={key.id}
        statusUrl={buildStatusUrl(key.publicId)}
        currentMode={key.monitorMode}
        currentWindowSeconds={key.monitorWindowSeconds}
        state={monitorState.kind}
        trippedAt={
          monitorState.kind === "tripped"
            ? monitorState.trippedAt.toISOString()
            : null
        }
      />

      <section className="mt-8">
        <div className="flex items-baseline justify-between mb-3">
          <h2 className="text-base font-semibold">hits</h2>
          <span className="text-xs text-neutral-500">
            {recent.length === 100 ? "showing latest 100" : `${recent.length} total`}
          </span>
        </div>

        {recent.length === 0 ? (
          <div className="text-center py-12 text-neutral-500 border border-dashed border-neutral-900 rounded">
            no hits yet. fetch the URL above to trigger one.
          </div>
        ) : (
          <div className="space-y-1.5">
            {recent.map((h) => (
              <HitRow
                key={h.id}
                hit={h}
                notifications={notifsByHit.get(h.id) ?? []}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border border-neutral-900 rounded p-3 bg-neutral-950/40">
      <div className="text-xs uppercase tracking-wide text-neutral-500 mb-2">
        {title}
      </div>
      {children}
    </div>
  );
}

function HitRow({
  hit,
  notifications: notifs,
}: {
  hit: Hit;
  notifications: Notification[];
}) {
  const headers = (hit.headers ?? {}) as Record<string, string>;
  const ctx = parseHostContext(headers);
  const uaLabel = formatUaLabel(hit);
  return (
    <details className="border border-neutral-900 rounded bg-neutral-950 overflow-hidden">
      <summary className="px-3 py-2 cursor-pointer flex items-center gap-3 text-sm hover:bg-neutral-900/50">
        <span className="text-neutral-500 text-xs w-20 shrink-0">
          {relativeTime(hit.occurredAt)}
        </span>
        <span className="font-mono text-neutral-300 w-32 shrink-0">
          {hit.ip ?? "—"}
        </span>
        <span className="text-neutral-400 truncate flex-1">
          {ctx ? <HostContextChip ctx={ctx} /> : uaLabel}
        </span>
        {hit.botLabel && !ctx && (
          <span className="text-amber-500 text-xs shrink-0 bg-amber-950/40 px-1.5 py-0.5 rounded">
            {hit.botLabel}
          </span>
        )}
        {hit.isDuplicate && (
          <span className="text-neutral-500 text-xs shrink-0 bg-neutral-900 px-1.5 py-0.5 rounded">
            dup
          </span>
        )}
        <NotifySummary notifs={notifs} isDup={hit.isDuplicate} />
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
                <Row
                  k="ssh from"
                  v={ctx.ssh_client_ip}
                  className="text-amber-300"
                />
              )}
              {ctx.ssh_connection && (
                <Row k="ssh full" v={ctx.ssh_connection} />
              )}
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
          <Row k="when" v={hit.occurredAt.toISOString()} />
          <Row k="ip" v={hit.ip ?? "—"} />
          <Row
            k="ua"
            v={
              hit.uaBrowser
                ? `${hit.uaBrowser} ${hit.uaBrowserVersion ?? ""} on ${hit.uaOs ?? "?"} (${hit.uaDevice ?? "?"})`
                : (hit.userAgent ?? "—")
            }
          />
          {hit.botLabel && <Row k="bot" v={hit.botLabel} className="text-amber-400" />}
          <Row k="referer" v={hit.referer ?? "—"} />
        </div>

        {notifs.length > 0 && (
          <div>
            <div className="text-neutral-500 mb-1">notifications</div>
            <div className="space-y-1">
              {notifs.map((n) => (
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
  return (
    <span className="text-emerald-400">
      {parts.join(" · ")}
    </span>
  );
}

function NotifLine({ n }: { n: Notification }) {
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
            ({n.attempts}/{n.maxAttempts} attempts
            {n.status === "pending" && n.nextAttemptAt
              ? `, next ${relativeTime(n.nextAttemptAt)}`
              : ""}
            )
          </span>
        )}
        {n.lastError && (
          <div className="text-red-400 mt-0.5 break-words">{n.lastError}</div>
        )}
      </span>
    </div>
  );
}

function NotifySummary({
  notifs,
  isDup,
}: {
  notifs: Notification[];
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
      {succeeded > 0 && <span className="text-emerald-500">✓{succeeded}</span>}
      {pending > 0 && <span className="text-amber-400">⏳{pending}</span>}
      {failed > 0 && <span className="text-red-400">⚠{failed}</span>}
    </span>
  );
}

function formatUaLabel(hit: Hit): string {
  if (hit.uaBrowser) {
    return `${hit.uaBrowser}${hit.uaBrowserVersion ? ` ${hit.uaBrowserVersion}` : ""} · ${hit.uaOs ?? "?"}`;
  }
  return hit.userAgent ?? "no UA";
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

const btnSecondary =
  "text-xs text-neutral-400 hover:text-neutral-100 bg-neutral-900 border border-neutral-800 rounded px-2 py-1 cursor-pointer font-[inherit]";
