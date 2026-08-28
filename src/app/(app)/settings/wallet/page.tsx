import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { describeConfigSource } from "@/lib/installers/wallet-store";
import { getSessionApiKey } from "@/lib/session";
import { deleteWalletConfigAction } from "./actions";

export const dynamic = "force-dynamic";

// The five env vars that must all be set for the feature to turn on. Kept in
// sync with getApplePassConfig() in src/lib/env.ts.
const REQUIRED_ENV_VARS = [
  "APPLE_PASS_CERT_PATH",
  "APPLE_PASS_CERT_PASS",
  "APPLE_PASS_TEAM_ID",
  "APPLE_PASS_TYPE_ID",
  "APPLE_PASS_AUTH_SECRET",
];

export default async function WalletSettingsPage() {
  const session = await getSessionApiKey();
  if (!session) redirect("/login");
  if (!session.isAdmin) notFound(); // 404 hides existence from non-admins

  const status = await describeConfigSource();

  return (
    <div className="max-w-2xl">
      <div className="mb-4">
        <Link
          href="/keys"
          className="text-xs text-neutral-500 no-underline hover:text-neutral-300"
        >
          ← keys
        </Link>
      </div>

      <nav aria-label="settings" className="flex gap-4 text-xs mb-6">
        <Link
          href="/settings/notifications"
          className="text-neutral-500 no-underline hover:text-neutral-300"
        >
          notifications
        </Link>
        <span className="text-neutral-200">apple wallet</span>
      </nav>

      <h1 className="text-xl font-semibold mb-1">Apple Wallet</h1>
      <p className="text-sm text-neutral-500 mb-6">
        Pass Type ID signing lets keys mint .pkpass files that call back to
        mantis on install / uninstall / fetch. Requires an Apple Developer
        Program membership and a Pass Type ID certificate.
      </p>

      <StatusCard status={status} />

      <div className="mt-6 text-sm text-neutral-400 bg-neutral-950/60 border border-neutral-900 rounded p-4 space-y-3">
        <p>
          <strong className="text-neutral-200">
            Configure this in your deploy, not here.
          </strong>{" "}
          Wallet signing is set through <code>APPLE_PASS_*</code> environment
          variables — mount the certificate and auth secret as docker secrets so
          they live with your infrastructure, not in the app database. This page
          is read-only; it just shows what mantis currently has wired up.
        </p>
        <div>
          <p className="mb-1 text-neutral-500">
            Required — set all five (see{" "}
            <code className="text-neutral-400">.env.example</code>):
          </p>
          <ul className="font-mono text-xs text-neutral-300 space-y-0.5">
            {REQUIRED_ENV_VARS.map((name) => (
              <li key={name}>{name}</li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-neutral-600">
            Optional: <code>APPLE_PASS_WWDR_PATH</code>, icon/logo PNG paths,{" "}
            <code>APPLE_PASS_ORG_NAME</code>, and the{" "}
            <code>APPLE_PASS_APNS_*</code> push vars. A partial config stays off
            — all five required vars must be present.
          </p>
        </div>
        <p className="text-xs text-neutral-600">
          After setting them, redeploy so the container picks up the new
          environment. The status above refreshes once mantis restarts.
        </p>
      </div>

      {status.dbConfigured && (
        <div className="mt-6 text-sm text-neutral-400 bg-amber-950/20 border border-amber-900/50 rounded p-4">
          <p className="mb-1">
            <strong className="text-amber-300">Legacy database config</strong> —
            a wallet config is stored in the app database from an earlier
            version.{" "}
            {status.envOverrides
              ? "Your env vars take precedence, so this stored copy is dormant. Clear it to remove the stored certificate and auth secret."
              : "It's currently active. Move to the env vars above (they override the DB), then clear this to remove the stored certificate and auth secret."}
          </p>
          <form action={deleteWalletConfigAction} className="mt-3">
            <button
              type="submit"
              className="text-xs text-red-400 hover:text-red-300 bg-transparent border border-red-900 rounded px-3 py-1.5 cursor-pointer"
            >
              clear legacy DB config
            </button>
            {!status.envOverrides && (
              <p className="text-xs text-neutral-600 mt-2">
                With no env vars set, this disables Apple Wallet. Existing passes
                on devices stop working (Wallet callbacks 503 and eventually
                retry).
              </p>
            )}
          </form>
        </div>
      )}
    </div>
  );
}

function StatusCard({
  status,
}: {
  status: Awaited<ReturnType<typeof describeConfigSource>>;
}) {
  const label =
    status.source === "env"
      ? "Configured via env vars"
      : status.source === "db"
        ? "Configured (legacy DB)"
        : "Not configured";
  const color =
    status.source === null ? "text-amber-400" : "text-emerald-400";
  return (
    <div className="border border-neutral-900 rounded p-3 bg-neutral-950/40 text-sm">
      <div className={`uppercase tracking-wide text-xs ${color} mb-1`}>
        {label}
      </div>
      {status.source && (
        <div className="text-neutral-400 text-xs space-y-0.5">
          <div>
            <span className="text-neutral-500">pass type:</span>{" "}
            <code className="text-neutral-300">{status.passTypeId}</code>
          </div>
          <div>
            <span className="text-neutral-500">team:</span>{" "}
            <code className="text-neutral-300">{status.teamId}</code>
          </div>
          <div>
            <span className="text-neutral-500">org:</span>{" "}
            <code className="text-neutral-300">{status.organizationName}</code>
          </div>
        </div>
      )}
    </div>
  );
}
