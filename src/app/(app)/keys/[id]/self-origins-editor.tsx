"use client";

import { useActionState, useEffect, useState } from "react";
import { useFormStatus } from "react-dom";
import { setSelfOriginsAction, type SelfOriginsActionState } from "../actions";

export function SelfOriginsEditor({ keyId, initial }: { keyId: string; initial: string[] }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(initial.join("\n"));
  const [dirty, setDirty] = useState(false);
  const [state, formAction] = useActionState<SelfOriginsActionState, FormData>(
    setSelfOriginsAction,
    {},
  );
  useEffect(() => {
    if (state.saved || state.error) setDirty(false);
  }, [state]);

  const startEditing = () => {
    setValue(initial.join("\n"));
    setDirty(false);
    setEditing(true);
  };

  if (!editing) {
    return (
      <button type="button" onClick={startEditing} className="text-xs text-blue-400 hover:underline bg-transparent border-0 p-0 cursor-pointer font-[inherit]">
        {initial.length === 0 ? "+ add your site's origin" : "edit origins"}
      </button>
    );
  }

  return (
    <form action={formAction} className="mt-3 space-y-3">
      <input type="hidden" name="id" value={keyId} />
      <label className="block text-xs text-neutral-500">
        one origin per line, for example https://www.example.com
        <textarea
          name="self_origins"
          rows={3}
          value={value}
          onChange={(e) => {
            setDirty(true);
            setValue(e.target.value);
          }}
          className="block mt-1 w-full bg-neutral-900 border border-neutral-800 rounded px-2 py-1.5 text-neutral-100 font-mono"
        />
      </label>
      {state.error && !dirty && <p role="alert" className="text-xs text-red-400">{state.error}</p>}
      {state.saved && !dirty && <p role="status" className="text-xs text-emerald-400">Origins saved.</p>}
      <div className="flex gap-3 items-center">
        <SaveButton />
        <button type="button" onClick={() => setEditing(false)} className="text-xs text-neutral-400 hover:text-neutral-100 bg-transparent border-0 p-0 cursor-pointer font-[inherit]">cancel</button>
      </div>
    </form>
  );
}

function SaveButton() {
  const { pending } = useFormStatus();
  return <button type="submit" disabled={pending} className="text-xs bg-neutral-100 text-neutral-900 rounded px-3 py-1.5 disabled:opacity-50">{pending ? "saving…" : "save origins"}</button>;
}
