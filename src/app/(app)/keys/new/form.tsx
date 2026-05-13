"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";
import { createKeyAction, type CreateState } from "./actions";

const RESPONSE_KINDS = [
  { value: "gif", label: "1×1 transparent GIF (tracking pixel)" },
  { value: "empty", label: "empty (204 No Content)" },
  { value: "json", label: "JSON" },
  { value: "redirect", label: "302 redirect" },
  { value: "html", label: "custom HTML" },
] as const;

const CHANNELS = [
  { value: "webhook", label: "webhook (generic JSON)", placeholder: "https://example.com/hook" },
  { value: "email", label: "email", placeholder: "alerts@example.com" },
  { value: "slack", label: "Slack", placeholder: "https://hooks.slack.com/services/T.../B.../..." },
  { value: "discord", label: "Discord", placeholder: "https://discord.com/api/webhooks/.../..." },
  { value: "teams", label: "Microsoft Teams", placeholder: "https://*.webhook.office.com/webhookb2/..." },
] as const;

type Destination = { channel: string; target: string };

export function NewKeyForm() {
  const [state, formAction] = useActionState<CreateState, FormData>(
    createKeyAction,
    {},
  );
  const [kind, setKind] = useState<string>("gif");
  const [destinations, setDestinations] = useState<Destination[]>([
    { channel: "webhook", target: "" },
  ]);

  const addDestination = () =>
    setDestinations((d) => [...d, { channel: "webhook", target: "" }]);
  const removeDestination = (idx: number) =>
    setDestinations((d) => d.filter((_, i) => i !== idx));
  const updateDestination = (idx: number, patch: Partial<Destination>) =>
    setDestinations((d) =>
      d.map((row, i) => (i === idx ? { ...row, ...patch } : row)),
    );

  return (
    <form action={formAction} className="space-y-4">
      <Field label="memo" hint="A label for you — not visible to triggers.">
        <input
          name="memo"
          required
          autoFocus
          maxLength={500}
          placeholder="e.g. honeypot doc in /finance"
          className={inputCls}
        />
      </Field>

      <Field
        label="trigger response"
        hint="What does the mantis URL return when fetched?"
      >
        <select
          name="response_kind"
          value={kind}
          onChange={(e) => setKind(e.target.value)}
          className={inputCls}
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
            className={inputCls}
          />
        </Field>
      )}

      {kind === "html" && (
        <Field label="HTML body">
          <textarea
            name="html_body"
            rows={4}
            className={`${inputCls} font-mono`}
            placeholder="<!doctype html>…"
          />
        </Field>
      )}

      {kind === "json" && (
        <Field
          label="JSON body"
          hint="Leave blank to return {ok: true}."
        >
          <textarea
            name="json_body"
            rows={3}
            className={`${inputCls} font-mono`}
            placeholder='{"status":"ok"}'
          />
        </Field>
      )}

      <div>
        <div className="block text-xs uppercase tracking-wide text-neutral-500 mb-2">
          notify destinations
        </div>
        <p className="text-xs text-neutral-600 mb-2">
          One row per channel. When the key fires, mantis posts to each.
          Slack/Discord/Teams get platform-formatted messages; webhook gets raw
          JSON; email needs SMTP_URL on the server. A test ping fires
          immediately on save so you'll see it land.
        </p>
        <div className="space-y-2">
          {destinations.map((d, idx) => {
            const channelMeta =
              CHANNELS.find((c) => c.value === d.channel) ?? CHANNELS[0];
            return (
              <div key={idx} className="flex gap-2 items-start">
                <select
                  name={`destinations[${idx}][channel]`}
                  value={d.channel}
                  onChange={(e) =>
                    updateDestination(idx, { channel: e.target.value })
                  }
                  className={`${inputCls} w-36 shrink-0`}
                >
                  {CHANNELS.map((c) => (
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
                  placeholder={channelMeta.placeholder}
                  className={`${inputCls} flex-1`}
                />
                {destinations.length > 1 && (
                  <button
                    type="button"
                    onClick={() => removeDestination(idx)}
                    className="text-xs text-neutral-500 hover:text-red-400 bg-transparent border-0 cursor-pointer font-[inherit] px-2 py-2"
                    aria-label="remove destination"
                  >
                    ✕
                  </button>
                )}
              </div>
            );
          })}
        </div>
        <button
          type="button"
          onClick={addDestination}
          className="mt-2 text-xs text-blue-400 hover:underline bg-transparent border-0 cursor-pointer font-[inherit] p-0"
        >
          + add another destination
        </button>
      </div>

      <Field
        label="dedupe window (seconds)"
        hint="Repeat hits within this window are recorded but won't fire notifications. 0 to disable."
      >
        <input
          name="dedupe_window_seconds"
          type="number"
          defaultValue="60"
          min={0}
          max={86_400}
          className={inputCls}
        />
      </Field>

      {state.error && (
        <div className="text-sm text-red-400 bg-red-950/40 border border-red-900 rounded px-3 py-2">
          {state.error}
        </div>
      )}

      <Submit />
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
      className="bg-neutral-100 text-neutral-900 rounded px-4 py-2 text-sm font-medium hover:bg-white disabled:opacity-50"
    >
      {pending ? "creating…" : "create key"}
    </button>
  );
}

const inputCls =
  "w-full bg-neutral-900 border border-neutral-800 rounded px-3 py-2 text-neutral-100 placeholder-neutral-600 focus:outline-none focus:border-neutral-600";
