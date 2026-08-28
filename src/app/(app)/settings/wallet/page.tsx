import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { describeConfigSource } from "@/lib/installers/wallet-store";
import { getSessionApiKey } from "@/lib/session";
import { deleteWalletConfigAction } from "./actions";
import { WalletConfigForm } from "./form";

export const dynamic = "force-dynamic";

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
        Configure Pass Type ID signing so keys can mint .pkpass files that
        call back to mantis on install / uninstall / fetch. Requires an Apple
        Developer Program membership and a Pass Type ID certificate.
      </p>

      <StatusCard status={status} />

      {status.envOverrides ? (
        <div className="mt-6 text-sm text-neutral-400 bg-neutral-950/60 border border-neutral-900 rounded p-4">
          <p className="mb-2">
            <strong className="text-neutral-200">Env vars are set</strong> —
            those take precedence over anything saved here. To use the
            dashboard form, unset the <code>APPLE_PASS_*</code> env vars and
            redeploy.
          </p>
          <p className="text-xs text-neutral-500">
            Active: passTypeId{" "}
            <code className="text-neutral-300">{status.passTypeId}</code> ·
            team <code className="text-neutral-300">{status.teamId}</code> ·
            org{" "}
            <code className="text-neutral-300">{status.organizationName}</code>
          </p>
        </div>
      ) : (
        <>
          <div className="mt-8 mb-4">
            <h2 className="text-sm font-semibold text-neutral-300 mb-1">
              {status.dbConfigured ? "Replace config" : "Configure"}
            </h2>
            <p className="text-xs text-neutral-600">
              Uploading new files replaces the existing config wholesale.
              Existing passes installed on devices keep working as long as
              you don't change the Pass Type ID or rotate the auth secret.
            </p>
          </div>

          <WalletConfigForm
            defaults={{
              teamId: status.teamId,
              passTypeId: status.passTypeId,
              organizationName: status.organizationName,
            }}
          />

          {status.dbConfigured && (
            <form action={deleteWalletConfigAction} className="mt-8">
              <button
                type="submit"
                className="text-xs text-red-400 hover:text-red-300 bg-transparent border border-red-900 rounded px-3 py-1.5 cursor-pointer"
              >
                clear wallet config
              </button>
              <p className="text-xs text-neutral-600 mt-2">
                Disables Apple Wallet integration. Existing passes on devices
                stop working (Wallet callbacks will 503 and eventually retry).
              </p>
            </form>
          )}
        </>
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
        ? "Configured (DB)"
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
