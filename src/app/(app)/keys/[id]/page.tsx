import { eq } from "drizzle-orm";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { db } from "@/db/client";
import { keys } from "@/db/schema";
import { canAccessKey } from "@/lib/auth";
import { statusUrl as buildStatusUrl, keyUrl } from "@/lib/env";
import { isApplePassEnabled } from "@/lib/installers/apple-wallet";
import {
  fingerprintSecret,
  listDestinations,
} from "@/lib/notify/destinations";
import { computeMonitorState } from "@/lib/monitor";
import { getSessionApiKey } from "@/lib/session";
import { toggleKeyAction } from "../actions";
import { CopyUrl } from "./copy-url";
import { DeleteButton } from "./delete-button";
import { DownloadFormats } from "./download-formats";
import { HitsFeed } from "./hits-feed";
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
            <DownloadFormats
              keyId={key.id}
              memo={key.memo}
              initialLockedFormat={key.firstDownloadFormat}
            />
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
                  status === "ok" ? (
                    <>
                      <span aria-hidden="true" className="text-emerald-400">✓</span>
                      <span className="sr-only">activated</span>
                    </>
                  ) : status === "failed" ? (
                    <>
                      <span aria-hidden="true" className="text-red-400">⚠</span>
                      <span className="sr-only">activation failed</span>
                    </>
                  ) : (
                    <>
                      <span aria-hidden="true" className="text-neutral-600">·</span>
                      <span className="sr-only">not activated</span>
                    </>
                  );
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

      <HitsFeed keyId={key.id} dedupeWindowSeconds={key.dedupeWindowSeconds} />
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

const btnSecondary =
  "text-xs text-neutral-400 hover:text-neutral-100 bg-neutral-900 border border-neutral-800 rounded px-2 py-1 cursor-pointer font-[inherit]";
