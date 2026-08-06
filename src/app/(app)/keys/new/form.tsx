"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";
import { CHANNEL_META, channelMeta } from "@/lib/notify/channel-meta";
import { PRESETS, getPreset, type Preset } from "@/lib/presets";
import { createKeyAction, type CreateState } from "./actions";

const RESPONSE_KINDS = [
  { value: "gif", label: "1×1 transparent GIF (tracking pixel)" },
  { value: "empty", label: "empty (204 No Content)" },
  { value: "json", label: "JSON" },
  { value: "redirect", label: "302 redirect" },
  { value: "html", label: "custom HTML" },
] as const;

type Destination = { channel: string; target: string };

export function NewKeyForm({
  defaultMemo = "",
  hasGlobalDestinations = false,
  isAdmin = false,
}: {
  defaultMemo?: string;
  hasGlobalDestinations?: boolean;
  isAdmin?: boolean;
}) {
  const [state, formAction] = useActionState<CreateState, FormData>(
    createKeyAction,
    {},
  );

  const [preset, setPreset] = useState<Preset>(getPreset(null));
  // Response kind and dedupe follow the preset until the operator overrides
  // them; after that we stop clobbering their choice on preset switches.
  const [kind, setKind] = useState<string>(preset.responseKind);
  const [dedupe, setDedupe] = useState<string>(
    String(preset.dedupeWindowSeconds),
  );
  const [touched, setTouched] = useState({ kind: false, dedupe: false });
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [destinations, setDestinations] = useState<Destination[]>([]);

  const choosePreset = (id: string) => {
    const p = getPreset(id);
    setPreset(p);
    if (!touched.kind) setKind(p.responseKind);
    if (!touched.dedupe) setDedupe(String(p.dedupeWindowSeconds));
  };

  const addDestination = () =>
    setDestinations((d) => [...d, { channel: "webhook", target: "" }]);
  const removeDestination = (idx: number) =>
    setDestinations((d) => d.filter((_, i) => i !== idx));
  const updateDestination = (idx: number, patch: Partial<Destination>) =>
    setDestinations((d) =>
      d.map((row, i) => (i === idx ? { ...row, ...patch } : row)),
    );

  return (
    <form action={formAction} className="space-y-5">
      <p className="text-sm text-neutral-400 leading-relaxed">
        A mantis key is a tripwire. Pick what you&apos;re planting and mantis
        fills in sensible defaults — you can change any of them.
      </p>

      {/* 1 — what are you planting */}
      <fieldset className="border-0 p-0 m-0">
        <legend className="block text-xs uppercase tracking-wide text-neutral-500 mb-2">
          1 · what are you planting?
        </legend>
        <input type="hidden" name="preset" value={preset.id} />
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
          {PRESETS.map((p) => {
            const selected = p.id === preset.id;
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => choosePreset(p.id)}
                aria-pressed={selected}
                className={`text-left rounded border px-3 py-2 cursor-pointer font-[inherit] transition-colors ${
                  selected
                    ? "border-neutral-500 bg-neutral-900 text-neutral-100"
                    : "border-neutral-800 bg-neutral-950 text-neutral-400 hover:border-neutral-700"
                }`}
              >
                <span className="block text-sm">{p.label}</span>
                <span className="block text-xs text-neutral-600 mt-0.5 leading-snug">
                  {p.blurb}
                </span>
              </button>
            );
          })}
        </div>
      </fieldset>

      {/* 2 — name it */}
      <Field
        label="2 · name it"
        hint="A label for you — never visible to whoever trips it."
      >
        <input
          name="memo"
          required
          maxLength={500}
          defaultValue={defaultMemo}
          key={preset.id} // re-render placeholder when the preset changes
          placeholder={preset.memoExample || "e.g. honeypot doc in /finance"}
          className={`${inputBase} w-full`}
        />
      </Field>

      {/* derived defaults, visible but collapsed */}
      <div className="border border-neutral-900 rounded bg-neutral-950/40">
        <button
          type="button"
          onClick={() => setShowAdvanced((v) => !v)}
          aria-expanded={showAdvanced}
          className="w-full text-left px-3 py-2 text-xs text-neutral-400 hover:text-neutral-200 bg-transparent border-0 cursor-pointer font-[inherit] flex justify-between items-center"
        >
          <span>
            3 · trigger response:{" "}
            <span className="text-neutral-200">
              {RESPONSE_KINDS.find((r) => r.value === kind)?.label ?? kind}
            </span>
            {" · dedupe "}
            <span className="text-neutral-200">
              {dedupe === "0" ? "off" : `${dedupe}s`}
            </span>
          </span>
          <span aria-hidden="true">{showAdvanced ? "▾" : "▸"}</span>
        </button>

        {showAdvanced && (
          <div className="px-3 pb-3 space-y-4 border-t border-neutral-900 pt-3">
            <Field
              label="trigger response"
              hint="What the mantis URL returns when fetched. The preset picks the least conspicuous option for that medium."
            >
              <select
                name="response_kind"
                value={kind}
                onChange={(e) => {
                  setKind(e.target.value);
                  setTouched((t) => ({ ...t, kind: true }));
                }}
                className={`${inputBase} w-full`}
              >
                {RESPONSE_KINDS.map((k) => (
                  <option key={k.value} value={k.value}>
                    {k.label}
                  </option>
                ))}
              </select>
            </Field>

            {kind === "redirect" && (
              <Field label="redirect URL">
                <input
                  name="redirect_url"
                  type="url"
                  placeholder="https://example.com"
                  className={`${inputBase} w-full`}
                />
              </Field>
            )}

            {kind === "html" && (
              <Field label="HTML body">
                <textarea
                  name="html_body"
                  rows={4}
                  className={`${inputBase} w-full font-mono`}
                  placeholder="<!doctype html>…"
                />
              </Field>
            )}

            {kind === "json" && (
              <Field label="JSON body" hint="Leave blank to return {ok: true}.">
                <textarea
                  name="json_body"
                  rows={3}
                  className={`${inputBase} w-full font-mono`}
                  placeholder='{"status":"ok"}'
                />
              </Field>
            )}

            <Field
              label="dedupe window (seconds)"
              hint="Repeat hits inside this window are recorded but don't re-notify. 0 = alert on every hit (right for login/sudo alarms)."
            >
              <input
                name="dedupe_window_seconds"
                type="number"
                value={dedupe}
                onChange={(e) => {
                  setDedupe(e.target.value);
                  setTouched((t) => ({ ...t, dedupe: true }));
                }}
                min={0}
                max={86_400}
                className={`${inputBase} w-full`}
              />
            </Field>
          </div>
        )}
      </div>

      {/* 4 — destinations, now optional thanks to globals */}
      <div>
        <div className="block text-xs uppercase tracking-wide text-neutral-500 mb-2">
          4 · extra destinations (optional)
        </div>
        {hasGlobalDestinations ? (
          <p className="text-xs text-neutral-500 mb-2">
            Global destinations are configured, so this key already alerts you.
            Add rows here only to notify somewhere <em>extra</em> for this key.{" "}
            {isAdmin && (
              <Link
                href="/settings/notifications"
                className="text-blue-400 no-underline hover:underline"
              >
                manage global
              </Link>
            )}
          </p>
        ) : (
          <p className="text-xs text-amber-500/80 mb-2">
            No global destinations are configured — without a row here this key
            records hits but won&apos;t alert anyone.{" "}
            {isAdmin && (
              <Link
                href="/settings/notifications"
                className="text-blue-400 no-underline hover:underline"
              >
                set global destinations
              </Link>
            )}
          </p>
        )}

        <div className="space-y-2">
          {destinations.map((d, idx) => {
            const meta = channelMeta(d.channel);
            return (
              <div key={idx} className="flex gap-2 items-start">
                <select
                  name={`destinations[${idx}][channel]`}
                  value={d.channel}
                  onChange={(e) =>
                    updateDestination(idx, { channel: e.target.value })
                  }
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
                  value={d.target}
                  onChange={(e) =>
                    updateDestination(idx, { target: e.target.value })
                  }
                  placeholder={meta.placeholder}
                  className={`${inputBase} flex-1 min-w-0`}
                  aria-label={`destination ${idx + 1} target`}
                />
                <button
                  type="button"
                  onClick={() => removeDestination(idx)}
                  className="text-xs text-neutral-500 hover:text-red-400 bg-transparent border-0 cursor-pointer font-[inherit] px-2 py-2"
                  aria-label={`remove destination ${idx + 1}`}
                >
                  ✕
                </button>
              </div>
            );
          })}
        </div>
        <button
          type="button"
          onClick={addDestination}
          className="mt-2 text-xs text-blue-400 hover:underline bg-transparent border-0 cursor-pointer font-[inherit] p-0"
        >
          + add destination for this key
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

      <div className="flex items-center gap-3">
        <Submit />
        <Link
          href="/keys/bulk"
          className="text-xs text-neutral-500 no-underline hover:text-neutral-300"
        >
          need several at once? → bulk mint
        </Link>
      </div>
    </form>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="block text-xs uppercase tracking-wide text-neutral-500 mb-1">
        {label}
      </span>
      {children}
      {hint && <span className="block text-xs text-neutral-600 mt-1">{hint}</span>}
    </label>
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
      {pending ? "creating…" : "create key"}
    </button>
  );
}

// No width baked in — callers pick w-full / w-44 / flex-1. Two competing
// width utilities would be resolved by stylesheet order, not className order.
const inputBase =
  "bg-neutral-900 border border-neutral-800 rounded px-3 py-2 text-neutral-100 placeholder-neutral-600 focus:outline-none focus:border-neutral-600";
