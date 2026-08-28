import Link from "next/link";
import { redirect } from "next/navigation";
import { listGlobalDestinations } from "@/lib/notify/destinations";
import { getSessionApiKey } from "@/lib/session";
import { BulkForm } from "./form";

export const dynamic = "force-dynamic";

export default async function BulkKeysPage() {
  const session = await getSessionApiKey();
  if (!session) redirect("/login");

  const globals = await listGlobalDestinations();

  return (
    <div className="max-w-xl">
      <div className="mb-4">
        <Link
          href="/keys"
          className="text-xs text-neutral-500 no-underline hover:text-neutral-300"
        >
          ← keys
        </Link>
      </div>

      <h1 className="text-xl font-semibold mb-1">bulk mint</h1>
      <p className="text-sm text-neutral-500 mb-6 leading-relaxed">
        Pick a filetype, name one canary per line, and mantis mints them all and
        hands back a zip with one file per key. Use it to give every location or
        host its own key — a shared key tells you something fired, a
        per-location key tells you <em>where</em>.
      </p>

      <p className="text-sm text-neutral-500 mb-6 leading-relaxed">
        Setting up a machine rather than planting files?{" "}
        <Link
          href="/keys/device"
          className="text-blue-400 no-underline hover:underline"
        >
          new machine
        </Link>{" "}
        mints the host alarms — login, sudo, wake, boot, network — and hands
        back a bundle that installs them.
      </p>

      <BulkForm hasGlobalDestinations={globals.length > 0} />
    </div>
  );
}
