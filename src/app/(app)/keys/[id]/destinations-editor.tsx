"use client";

import { useActionState, useEffect, useState } from "react";
import { useFormStatus } from "react-dom";
import { setDestinationsAction, type DestinationsActionState } from "../actions";

type Row = { id: string; channel: string; target: string };

const CHANNELS = [
  ["webhook", "webhook"],
  ["email", "email"],
  ["slack", "Slack"],
  ["discord", "Discord"],
  ["teams", "Microsoft Teams"],
  ["home_assistant", "Home Assistant"],
] as const;

export function DestinationsEditor({ keyId, initial }: { keyId: string; initial: Row[] }) {
  const [editing, setEditing] = useState(false);
  const [rows, setRows] = useState<Row[]>(initial);
  const [dirty, setDirty] = useState(false);
  const [state, formAction] = useActionState<DestinationsActionState, FormData>(
    setDestinationsAction,
    {},
  );
  useEffect(() => {
    if (state.saved || state.error) setDirty(false);
  }, [state]);

  const startEditing = () => {
    setRows(initial);
    setDirty(false);
    setEditing(true);
  };

  if (!editing) {
    return (
      <button type="button" onClick={startEditing} className="text-xs text-blue-400 hover:underline bg-transparent border-0 p-0 cursor-pointer font-[inherit]">
        {initial.length === 0 ? "+ add a destination" : "edit destinations"}
      </button>
    );
  }

  return (
    <form action={formAction} className="mt-3 space-y-3">
      <input type="hidden" name="id" value={keyId} />
      <input type="hidden" name="destination_count" value={rows.length} />
      {rows.map((row, index) => (
        <div key={row.id} className="flex flex-wrap items-end gap-2">
          <label className="text-xs text-neutral-500">
            channel
            <select
              name={`channel_${index}`}
              value={row.channel}
              onChange={(e) => {
                setDirty(true);
                setRows((current) => current.map((item) => item.id === row.id ? { ...item, channel: e.target.value } : item));
              }}
              className="block mt-1 bg-neutral-900 border border-neutral-800 rounded px-2 py-1.5 text-neutral-100"
            >
              {CHANNELS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
          <label className="text-xs text-neutral-500 flex-1 min-w-48">
            destination URL or email
            <input
              name={`target_${index}`}
              required
              value={row.target}
              onChange={(e) => {
                setDirty(true);
                setRows((current) => current.map((item) => item.id === row.id ? { ...item, target: e.target.value } : item));
              }}
              className="block mt-1 w-full bg-neutral-900 border border-neutral-800 rounded px-2 py-1.5 text-neutral-100"
            />
          </label>
          <button type="button" onClick={() => { setDirty(true); setRows((current) => current.filter((item) => item.id !== row.id)); }} className="text-xs text-red-400 hover:underline bg-transparent border-0 p-1 cursor-pointer font-[inherit]" aria-label={`remove destination ${index + 1}`}>
            remove
          </button>
        </div>
      ))}
      <button type="button" onClick={() => { setDirty(true); setRows((current) => [...current, { id: crypto.randomUUID(), channel: "webhook", target: "" }]); }} disabled={rows.length >= 50} className="block text-xs text-blue-400 hover:underline bg-transparent border-0 p-0 cursor-pointer font-[inherit] disabled:opacity-50">
        + add destination
      </button>
      {state.error && !dirty && <p role="alert" className="text-xs text-red-400">{state.error}</p>}
      {state.saved && !dirty && <p role="status" className="text-xs text-emerald-400">Destinations saved. New destinations were tested; check their activation status above.</p>}
      <div className="flex gap-3 items-center">
        <SaveButton />
        <button type="button" onClick={() => setEditing(false)} className="text-xs text-neutral-400 hover:text-neutral-100 bg-transparent border-0 p-0 cursor-pointer font-[inherit]">cancel</button>
      </div>
    </form>
  );
}

function SaveButton() {
  const { pending } = useFormStatus();
  return <button type="submit" disabled={pending} className="text-xs bg-neutral-100 text-neutral-900 rounded px-3 py-1.5 disabled:opacity-50">{pending ? "saving and testing…" : "save destinations"}</button>;
}
