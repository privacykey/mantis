"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import type { MonitorDraftValues } from "@/lib/monitor-drafts";
import { parseMonitorSnapshot } from "@/lib/monitor-snapshot";
import {
  resetMonitorAction,
  setMonitorAction,
  type MonitorActionState,
} from "../actions";
import { useMonitorDraft } from "./use-monitor-draft";

type Mode = "off" | "latch" | "window";

export type MonitorCardProps = {
  draftScope: string;
  keyId: string;
  statusUrl: string;
  currentMode: Mode;
  currentWindowSeconds: number;
  state: "off" | "ok" | "tripped";
  trippedAt: string | null;
};

export function MonitorCard({
  draftScope,
  keyId,
  statusUrl,
  currentMode,
  currentWindowSeconds,
  state,
  trippedAt,
}: MonitorCardProps) {
  const [actionState, formAction, saving] = useActionState<
    MonitorActionState,
    FormData
  >(setMonitorAction, {});
  const draft = useMonitorDraft(draftScope, keyId, { mode: currentMode, windowSeconds: currentWindowSeconds });
  const { mode, windowInput } = draft.values;
  const submitted = useRef<MonitorDraftValues | null>(null);
  const [copied, setCopied] = useState(false);
  const [resetState, resetAction, resetting] = useActionState(resetMonitorAction, {});
  const [snapshotReady, setSnapshotReady] = useState(false);
  const [live, setLive] = useState({ state: state as "off" | "ok" | "tripped" | "unavailable", trippedAt, mode: currentMode, windowSeconds: currentWindowSeconds });
  useEffect(() => {
    submitted.current = null;
    setLive({ state, trippedAt, mode: currentMode, windowSeconds: currentWindowSeconds });
  }, [draftScope, keyId]);
  useEffect(() => {
    if (actionState.saved && submitted.current) draft.acknowledgeSave(submitted.current);
    else if (actionState.error) draft.failedSave(actionState.saveOutcomeUnknown === true);
  }, [actionState]);
  useEffect(() => {
    setSnapshotReady(false);
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    const poll = async () => {
      try {
        const response = await fetch(`/api/keys/${keyId}/monitor`, {
          cache: "no-store", redirect: "error", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
        });
        if (!response.ok) throw new Error("monitor status unavailable");
        const next = parseMonitorSnapshot(await response.json());
        if (!next) throw new Error("invalid monitor status");
        if (!disposed) {
          draft.reconcile(next);
          setLive(next);
          setSnapshotReady(true);
        }
      } catch {
        if (!disposed) {
          setLive((previous) => ({ ...previous, state: "unavailable" }));
          setSnapshotReady(false);
        }
      } finally {
        if (!disposed) timer = setTimeout(poll, 3000);
      }
    };
    void poll();
    return () => { disposed = true; controller.abort(); clearTimeout(timer); };
  }, [draftScope, keyId, actionState, resetState]);
  const canSubmit = snapshotReady && draft.loaded && !saving && !resetting;

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(statusUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  };

  return (
    <section className="mt-8 border border-neutral-900 rounded p-4 bg-neutral-950/40">
      <div className="flex items-baseline justify-between mb-1">
        <h2 className="text-base font-semibold">uptime monitor</h2>
        <StateBadge state={live.state} trippedAt={live.trippedAt} />
      </div>
      <p className="text-xs text-neutral-500 mb-3">
        Point an Uptime Kuma HTTP(s) monitor at the status URL — Kuma fires its
        configured notifications when it flips.
      </p>

      <form action={formAction} className="space-y-3" onSubmit={(event) => {
        if (!canSubmit) { event.preventDefault(); return; }
        submitted.current = draft.beginSave();
      }}>
        <input type="hidden" name="id" value={keyId} />
        <input type="hidden" name="monitor_draft_scope" value={draftScope} />
        <div className="flex flex-wrap items-end gap-3">
          <label className="block">
            <span className="block text-xs uppercase tracking-wide text-neutral-500 mb-1">
              mode
            </span>
            <select
              disabled={!draft.loaded}
              name="monitor_mode"
              value={mode}
              onChange={(e) => draft.edit({ mode: e.target.value as Mode })}
              className="bg-neutral-900 border border-neutral-800 rounded px-3 py-1.5 text-sm text-neutral-100 focus:outline-none focus:border-neutral-600"
            >
              <option value="off">off (no monitoring)</option>
              <option value="latch">latch (trip stays until reset)</option>
              <option value="window">window (auto-resets after N seconds)</option>
            </select>
          </label>
          {mode === "window" && (
            <label className="block">
              <span className="block text-xs uppercase tracking-wide text-neutral-500 mb-1">
                window (seconds)
              </span>
              <input
                disabled={!draft.loaded}
                type="number"
                name="monitor_window_seconds"
                value={windowInput}
                onChange={(e) => draft.edit({ windowInput: e.target.value })}
                min={30}
                max={86_400}
                className="bg-neutral-900 border border-neutral-800 rounded px-3 py-1.5 text-sm text-neutral-100 w-32 focus:outline-none focus:border-neutral-600"
              />
            </label>
          )}
          {mode !== "window" && (
            <input
              type="hidden"
              name="monitor_window_seconds"
              value={windowInput}
            />
          )}
          <SubmitButton canSubmit={canSubmit} />
        </div>
        {actionState.error && (
          <div role="alert" className="text-sm text-red-400">
            {actionState.error}
          </div>
        )}
        {draft.restored && <p role="status" className="text-xs text-amber-400">Unsaved monitor settings restored. Review them before saving.</p>}
        {draft.conflict && <p className="text-xs text-amber-400">Saved settings changed since this draft was created.</p>}
        {draft.unsaved && <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs">
          <p className="text-amber-400">Unsaved settings — status reflects saved {live.mode}{live.mode === "window" ? ` (${live.windowSeconds}s)` : ""} configuration.</p>
          <button type="button" onClick={draft.discard} className="text-neutral-400 underline hover:text-neutral-200">discard draft</button>
        </div>}
        {draft.unavailable && draft.unsaved && <p role="status" className="text-xs text-amber-400">Reload recovery is unavailable in this browser. Keep this tab open until you save.</p>}
        {draft.unavailable && !draft.unsaved && <p role="status" className="text-xs text-amber-400">Browser drafts could not be cleared. Review settings again after reloading.</p>}
        {!snapshotReady && <p role="status" className="text-xs text-neutral-400">Checking saved settings before changes can be applied…</p>}
        {actionState.saved && !draft.unsaved && <p role="status" className="text-xs text-emerald-400">Monitor settings saved.</p>}
      </form>

      {mode !== "off" && (
        <div className="mt-4 pt-3 border-t border-neutral-900">
          <div className="text-xs uppercase tracking-wide text-neutral-500 mb-1">
            status URL
          </div>
          <div className="flex items-center gap-2">
            <code className="text-sm font-mono text-blue-400 break-all flex-1">
              {statusUrl}
            </code>
            <button
              type="button"
              onClick={onCopy}
              className="text-xs text-neutral-400 hover:text-neutral-100 bg-neutral-900 border border-neutral-800 rounded px-2 py-1 cursor-pointer font-[inherit] shrink-0"
            >
              {copied ? "copied!" : "copy"}
            </button>
            <span role="status" className="sr-only">
              {copied ? "copied to clipboard" : ""}
            </span>
          </div>
        </div>
      )}

      {live.state === "tripped" && (
        <div className="mt-3">
          <form action={resetAction} onSubmit={(event) => { if (!canSubmit) event.preventDefault(); }}>
            <input type="hidden" name="id" value={keyId} />
            <input type="hidden" name="monitor_draft_scope" value={draftScope} />
            <ResetButton canSubmit={canSubmit} />
          </form>
        </div>
      )}
      {resetState.error && <p role="alert" className="mt-3 text-xs text-red-400">{resetState.error}</p>}
    </section>
  );
}

function StateBadge({
  state,
  trippedAt,
}: {
  state: "off" | "ok" | "tripped" | "unavailable";
  trippedAt: string | null;
}) {
  if (state === "unavailable") return <span role="status" className="text-xs text-amber-400">status unavailable — retrying…</span>;
  if (state === "off") {
    return <span className="text-xs text-neutral-600">disabled</span>;
  }
  if (state === "tripped") {
    return (
      <span className="text-xs text-red-400 px-2 py-1 bg-red-950/40 rounded">
        ● tripped{trippedAt ? ` @ ${formatTime(trippedAt)}` : ""}
      </span>
    );
  }
  return (
    <span className="text-xs text-emerald-400 px-2 py-1 bg-emerald-950/40 rounded">
      ● ok
    </span>
  );
}

function ResetButton({ canSubmit }: { canSubmit: boolean }) {
  const { pending } = useFormStatus();
  return <button type="submit" disabled={pending || !canSubmit} className="text-xs bg-amber-900/40 border border-amber-900 text-amber-300 hover:text-amber-100 rounded px-3 py-1.5 disabled:opacity-50">{pending ? "resetting…" : "reset trip"}</button>;
}

function SubmitButton({ canSubmit }: { canSubmit: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending || !canSubmit}
      className="text-xs bg-neutral-100 text-neutral-900 rounded px-3 py-1.5 hover:bg-white disabled:opacity-50 cursor-pointer font-[inherit]"
    >
      {pending ? "saving…" : "save"}
    </button>
  );
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}
