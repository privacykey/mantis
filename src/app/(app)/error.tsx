"use client";

export default function DashboardError({
  error,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const appUpdated = error.name === "UnrecognizedActionError";

  return (
    <section role="alert" className="max-w-xl rounded border border-neutral-800 bg-neutral-950/40 p-6">
      <h1 className="mb-2 text-xl font-semibold">
        {appUpdated ? "Mantis was updated" : "This page is unavailable"}
      </h1>
      <p className="text-sm text-neutral-300">
        {appUpdated
          ? "This page belongs to an earlier version. Reload to continue, then check the current state before trying your action again."
          : "Reload to get the latest page. If you were making a change, check its current status before trying it again."}
      </p>
      <p className="mt-3 text-sm text-neutral-400">
        Unsaved changes may need to be entered again.
      </p>
      <button
        type="button"
        onClick={() => window.location.reload()}
        className="mt-5 rounded bg-neutral-100 px-4 py-2 text-sm text-neutral-900 hover:bg-white focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-neutral-100"
      >
        Reload this page
      </button>
    </section>
  );
}
