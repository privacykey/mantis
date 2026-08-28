"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";
import { CHANNEL_META, channelMeta } from "@/lib/notify/channel-meta";
import {
  saveGlobalDestinationsAction,
  type GlobalDestState,
} from "./actions";

export type ExistingDestination = {
  id: string;
  channel: string;
  target: string;
  lastActivationStatus: string | null;
  lastActivationError: string | null;
};

type Row = { channel: string; target: string };

export function GlobalDestinationsForm({
  existing,
}: {
  existing: ExistingDestination[];
}) {
  const [state, formAction] = useActionState<GlobalDestState, FormData>(
    saveGlobalDestinationsAction,
    {},
  );
  const [rows, setRows] = useState<Row[]>(
    existing.length > 0
      ? existing.map((d) => ({ channel: d.channel, target: d.target }))
      : [{ channel: "webhook", target: "" }],
  );

  const statusFor = (row: Row) =>
    existing.find((d) => d.channel === row.channel && d.target === row.target);

  const update = (idx: number, patch: Partial<Row>) =>
    setRows((r) => r.map((x, i) => (i === idx ? { ...x, ...patch } : x)));

  return (
    <form action={formAction} className="space-y-3">
      <div className="space-y-3">
        {rows.map((row, idx) => {
          const meta = channelMeta(row.channel);
          const saved = statusFor(row);
          return (
            <div key={idx} className="space-y-1">
              <div className="flex gap-2 items-start">
                <select
                  name={`destinations[${idx}][channel]`}
                  value={row.channel}
                  onChange={(e) => update(idx, { channel: e.target.value })}
                  className={`${inputBase} w-44 shrink-0`}
                  aria-label={`destination ${idx + 1} channel`}
                >
                  {CHANNEL_META.map((c) => (
                    <option key={c.value} value={c.value}>
                      {c.label}
                    </option>
                  ))}
                </select>
                <input
                  name={`destinations[${idx}][target]`}
                  value={row.target}
                  onChange={(e) => update(idx, { target: e.target.value })}
                  placeholder={meta.placeholder}
                  className={`${inputBase} flex-1 min-w-0`}
                  aria-label={`destination ${idx + 1} target`}
                />
                <button
                  type="button"
                  onClick={() => setRows((r) => r.filter((_, i) => i !== idx))}
                  className="text-xs text-neutral-500 hover:text-red-400 bg-transparent border-0 cursor-pointer font-[inherit] px-2 py-2"
                  aria-label={`remove destination ${idx + 1}`}
                >
                  ✕
                </button>
              </div>
              <div className="text-xs text-neutral-600 pl-1">{meta.help}</div>
              {saved?.lastActivationStatus === "failed" && (
                <div className="text-xs text-red-400 pl-1">
                  last test failed: {saved.lastActivationError}
                </div>
              )}
              {saved?.lastActivationStatus === "ok" && (
                <div className="text-xs text-emerald-500 pl-1">
                  test delivered ✓
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div>
        <button
          type="button"
          onClick={() =>
            setRows((r) => [...r, { channel: "webhook", target: "" }])
          }
          className="text-xs text-blue-400 hover:underline bg-transparent border-0 cursor-pointer font-[inherit] p-0"
        >
          + add destination
        </button>
      </div>

      {state.error && (
        <div
          role="alert"
          className="text-sm text-red-400 bg-red-950/40 border border-red-900 rounded px-3 py-2"
        >
          {state.error}
        </div>
      )}

      {state.ok && (
        <div className="text-sm bg-neutral-950/60 border border-neutral-900 rounded px-3 py-2 space-y-1">
          <div className="text-neutral-300">Saved.</div>
          {state.results?.map((r, i) => (
            <div
              key={i}
              className={r.ok ? "text-emerald-500 text-xs" : "text-red-400 text-xs"}
            >
              {r.ok ? "✓ test delivered to " : "✗ test failed for "}
              <code className="text-neutral-400">{r.target}</code>
              {r.error ? ` — ${r.error}` : ""}
            </div>
          ))}
          {state.results?.length === 0 && (
            <div className="text-xs text-neutral-500">
              No global destinations. Keys now alert only via their own
              destinations.
            </div>
          )}
        </div>
      )}

      <Submit />
    </form>
  );
}

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="bg-neutral-100 text-neutral-900 rounded px-4 py-2 text-sm font-medium hover:bg-white disabled:opacity-50 cursor-pointer"
    >
      {pending ? "saving…" : "save destinations"}
    </button>
  );
}

// No width here on purpose. Callers add w-full / w-44 / flex-1 themselves —
// baking `w-full` in and appending `w-44` at the call site produces two
// competing width utilities, and Tailwind resolves that by stylesheet order
// rather than className order, so the loser is essentially arbitrary.
const inputBase =
  "bg-neutral-900 border border-neutral-800 rounded px-3 py-2 text-neutral-100 placeholder-neutral-600 focus:outline-none focus:border-neutral-600";
