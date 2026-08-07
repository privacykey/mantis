import Link from "next/link";
import { redirect } from "next/navigation";
import { listGlobalDestinations } from "@/lib/notify/destinations";
import { getSessionApiKey } from "@/lib/session";
import { DeviceForm } from "./form";

export const dynamic = "force-dynamic";

export default async function DeviceKeysPage() {
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

      <h1 className="text-xl font-semibold mb-1">new machine</h1>
      <p className="text-sm text-neutral-500 mb-6 leading-relaxed">
        Mint the full set of host alarms for one machine — login, sudo, wake,
        boot, network — one key each, and download a bundle that installs them
        all. A key per alarm is what makes a hit legible:{" "}
        <em>web01 — wake from sleep</em> at 03:00 tells you something{" "}
        <em>web01</em> alone never could.
      </p>

      <DeviceForm hasGlobalDestinations={globals.length > 0} />
    </div>
  );
}
