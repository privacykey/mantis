import { redirect } from "next/navigation";
import { listGlobalDestinations } from "@/lib/notify/destinations";
import { getSessionApiKey } from "@/lib/session";
import { NewKeyForm } from "./form";

export const dynamic = "force-dynamic";

export default async function NewKeyPage({
  searchParams,
}: {
  searchParams: Promise<{ memo?: string }>;
}) {
  const session = await getSessionApiKey();
  if (!session) redirect("/login");

  // Prefilled when arriving from a key's "new key for a different filetype"
  // shortcut, so an operator can mint a sibling key in one step.
  const { memo } = await searchParams;
  const defaultMemo = typeof memo === "string" ? memo.slice(0, 500) : "";

  // Drives the destinations copy: with globals configured, per-key
  // destinations are genuinely optional and the form says so instead of
  // pushing every operator to paste the same webhook URL again.
  const globals = await listGlobalDestinations();

  return (
    <div className="max-w-xl">
      <h1 className="text-xl font-semibold mb-1">new key</h1>
      <p className="text-sm text-neutral-500 mb-6">
        {defaultMemo
          ? "Mint a sibling key so you can download a different filetype and keep hits traceable to one file each."
          : "A new mantis URL will be minted. Anyone who hits it will be logged."}
      </p>
      <NewKeyForm
        defaultMemo={defaultMemo}
        hasGlobalDestinations={globals.length > 0}
        isAdmin={session.isAdmin}
      />
    </div>
  );
}
