"use client";

import Link from "next/link";
import { useActionState, useEffect, useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import { BULK_PRESETS, getPreset, type Preset } from "@/lib/presets";
import { bulkCreateAction, type BulkState } from "./actions";

/** Starter rows for the "one key per use case" pattern. */
const SUGGESTIONS: Record<string, string[]> = {
  "shell-login": ["ssh login — web01", "ssh login — db01", "ssh login — nas"],
  "shell-sudo": ["sudo — web01", "sudo — db01"],
  default: [
    "finance share",
    "hr share",
    "backups folder",
    "admin desktop",
  ],
};

export function BulkForm({ hasGlobalDestinations }: { hasGlobalDestinations: boolean }) {
  const [state, formAction] = useActionState<BulkState, FormData>(
    bulkCreateAction,
    {},
  );
  const [preset, setPreset] = useState<Preset>(BULK_PRESETS[0]!);
  const [names, setNames] = useState("");
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const autoDownloaded = useRef<string | null>(null);

  const count = names
    .split("\n")
    .map((n) => n.trim())
    .filter(Boolean).length;

  const download = async (ids: string[], format: string) => {
    setDownloading(true);
    setDownloadError(null);
    try {
      const res = await fetch("/api/keys/bulk-download", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids, format }),
      });
      if (!res.ok) {
        const msg = await res.text();
        throw new Error(`download failed (${res.status}): ${msg.slice(0, 200)}`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `mantis-${format}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setDownloadError(err instanceof Error ? err.message : String(err));
    } finally {
      setDownloading(false);
    }
  };

  // Keys are already minted at this point; the zip is a convenience, so a
  // failed download is recoverable via the button rather than fatal.
  useEffect(() => {
    const created = state.created;
    const format = state.downloadFormat;
    if (!created || created.length === 0 || !format) return;
    const batch = created.map((c) => c.id).join(",");
    if (autoDownloaded.current === batch) return;
    autoDownloaded.current = batch;
    void download(
      created.map((c) => c.id),
      format,
    );
  }, [state.created, state.downloadFormat]);

  const suggestions = SUGGESTIONS[preset.id] ?? SUGGESTIONS.default!;

  return (
    <div className="space-y-6">
      <form action={formAction} className="space-y-5">
        <fieldset className="border-0 p-0 m-0">
          <legend className="block text-xs uppercase tracking-wide text-neutral-500 mb-2">
            1 · filetype
          </legend>
          <input type="hidden" name="preset" value={preset.id} />
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {BULK_PRESETS.map((p) => {
              const selected = p.id === preset.id;
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => setPreset(getPreset(p.id))}
                  aria-pressed={selected}
                  className={`text-left rounded border px-3 py-2 cursor-pointer font-[inherit] transition-colors ${
                    selected
                      ? "border-neutral-500 bg-neutral-900 text-neutral-100"
                      : "border-neutral-800 bg-neutral-950 text-neutral-400 hover:border-neutral-700"
                  }`}
                >
                  <span className="block text-sm">{p.label}</span>
                  <span className="block text-xs text-neutral-600 mt-0.5">
                    .{p.downloadFormat}
                  </span>
                </button>
              );
            })}
          </div>
        </fieldset>

        <label className="block">
          <span className="block text-xs uppercase tracking-wide text-neutral-500 mb-1">
            2 · names — one per line
          </span>
          <textarea
            name="names"
            rows={7}
            required
            value={names}
            onChange={(e) => setNames(e.target.value)}
            placeholder={suggestions.join("\n")}
            className="w-full bg-neutral-900 border border-neutral-800 rounded px-3 py-2 text-neutral-100 placeholder-neutral-700 focus:outline-none focus:border-neutral-600 font-mono text-sm"
          />
          <span className="block text-xs text-neutral-600 mt-1">
            One key per line — {count === 0 ? "none yet" : `${count} key${count === 1 ? "" : "s"}`}
            , max 50. Each gets its own URL, so a hit tells you exactly which
            one was touched.
          </span>
        </label>

        <div className="text-xs text-neutral-600 border border-neutral-900 rounded bg-neutral-950/40 px-3 py-2">
          3 · trigger response{" "}
          <span className="text-neutral-400">{preset.responseKind}</span> ·
          dedupe{" "}
          <span className="text-neutral-400">
            {preset.dedupeWindowSeconds === 0
              ? "off"
              : `${preset.dedupeWindowSeconds}s`}
          </span>{" "}
          — from the filetype. Need something different?{" "}
          <Link
            href="/keys/new"
            className="text-blue-400 no-underline hover:underline"
          >
            mint one at a time
          </Link>
          .
        </div>

        {!hasGlobalDestinations && (
          <div className="text-xs text-amber-500/80 border border-amber-900/40 bg-amber-950/20 rounded px-3 py-2">
            No global destinations configured. Bulk keys get no per-key
            destinations, so these would record hits without alerting anyone.{" "}
            <Link
              href="/settings/notifications"
              className="text-blue-400 no-underline hover:underline"
            >
              set them up first
            </Link>
            .
          </div>
        )}

        {state.error && (
          <div
            role="alert"
            className="text-sm text-red-400 bg-red-950/40 border border-red-900 rounded px-3 py-2"
          >
            {state.error}
          </div>
        )}

        <Submit count={count} />
      </form>

      {state.created && state.created.length > 0 && (
        <div className="border border-neutral-900 rounded bg-neutral-950/40 p-4 space-y-3">
          <div className="text-sm text-emerald-500">
            Created {state.created.length} key
            {state.created.length === 1 ? "" : "s"}.
            {downloading && " Preparing your download…"}
          </div>

          {downloadError && (
            <div className="text-xs text-red-400">
              Keys were created, but the zip failed: {downloadError}
            </div>
          )}

          <ul className="text-xs text-neutral-400 space-y-1 list-none p-0 m-0">
            {state.created.map((c) => (
              <li key={c.id}>
                <Link
                  href={`/keys/${c.id}`}
                  className="text-neutral-300 no-underline hover:underline"
                >
                  {c.memo}
                </Link>{" "}
                <span className="text-neutral-600">/c/{c.publicId}</span>
              </li>
            ))}
          </ul>

          {state.downloadFormat && (
            <button
              type="button"
              disabled={downloading}
              onClick={() =>
                download(
                  state.created!.map((c) => c.id),
                  state.downloadFormat!,
                )
              }
              className="text-xs bg-neutral-100 text-neutral-900 rounded px-3 py-1.5 font-medium hover:bg-white disabled:opacity-50 cursor-pointer border-0"
            >
              {downloading ? "zipping…" : "download again (.zip)"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function Submit({ count }: { count: number }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending || count === 0}
      className="bg-neutral-100 text-neutral-900 rounded px-4 py-2 text-sm font-medium hover:bg-white disabled:opacity-50 cursor-pointer"
    >
      {pending
        ? "creating…"
        : count === 0
          ? "create + download"
          : `create ${count} key${count === 1 ? "" : "s"} + download`}
    </button>
  );
}
