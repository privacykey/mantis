import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { listGlobalDestinations } from "@/lib/notify/destinations";
import { getSessionApiKey } from "@/lib/session";
import { GlobalDestinationsForm } from "./form";

export const dynamic = "force-dynamic";

export default async function NotificationSettingsPage() {
  const session = await getSessionApiKey();
  if (!session) redirect("/login");
  if (!session.isAdmin) notFound(); // 404 hides existence from non-admins

  const destinations = await listGlobalDestinations();

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
        <span className="text-neutral-200">notifications</span>
        <Link
          href="/settings/wallet"
          className="text-neutral-500 no-underline hover:text-neutral-300"
        >
          apple wallet
        </Link>
      </nav>

      <h1 className="text-xl font-semibold mb-1">Global notify destinations</h1>
      <p className="text-sm text-neutral-500 mb-6 leading-relaxed">
        These receive alerts from <strong className="text-neutral-300">every</strong>{" "}
        key, in addition to whatever destinations a key sets for itself. Set
        your Slack or webhook once here and every key you mint — including bulk
        ones — alerts you without further setup. A destination listed both here
        and on a key only fires once.
      </p>

      <div className="border border-neutral-900 rounded p-3 bg-neutral-950/40 text-sm mb-6">
        <div
          className={`uppercase tracking-wide text-xs mb-1 ${
            destinations.length > 0 ? "text-emerald-400" : "text-amber-400"
          }`}
        >
          {destinations.length > 0
            ? `${destinations.length} global destination${destinations.length === 1 ? "" : "s"}`
            : "No global destinations"}
        </div>
        <div className="text-neutral-500 text-xs">
          {destinations.length > 0
            ? "Every key alerts here when it fires."
            : "Keys alert only via their own destinations. A key with none is silent."}
        </div>
      </div>

      <p className="text-xs text-neutral-600 mb-3">
        A test message fires to each new destination on save, so you&apos;ll see
        it land (or see why it didn&apos;t).
      </p>

      <GlobalDestinationsForm
        existing={destinations.map((d) => ({
          id: d.id,
          channel: d.channel,
          target: d.target,
          lastActivationStatus: d.lastActivationStatus,
          lastActivationError: d.lastActivationError,
        }))}
      />
    </div>
  );
}
