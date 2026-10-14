"use client";

import { useEffect, useRef, useState } from "react";
import {
  acknowledgeMonitorDraft, beginMonitorDraftSave, clearMonitorDrafts, draftIsSettled, failMonitorDraftSave, monitorDraftValues, readMonitorDraft,
  removeMonitorDraft, settingsMatch, writeMonitorDraft,
  type DraftStorage, type MonitorDraft, type MonitorDraftValues, type MonitorSettings,
} from "@/lib/monitor-drafts";

export function useMonitorDraft(scope: string, keyId: string, initialSaved: MonitorSettings) {
  const identity = `${scope}:${keyId}`;
  const saved = useRef(initialSaved);
  const values = useRef(monitorDraftValues(initialSaved));
  const draft = useRef<MonitorDraft | null>(null);
  const submissionActive = useRef(false);
  const storage = useRef<DraftStorage | null>(null);
  const [view, setView] = useState({ identity, values: values.current, loaded: false, restored: false, conflict: false, unavailable: false });

  const persist = (next: MonitorDraft | null) => {
    try {
      if (!storage.current) throw new Error("draft storage unavailable");
      if (next) writeMonitorDraft(storage.current, scope, keyId, next);
      else removeMonitorDraft(storage.current, scope, keyId);
      setView((previous) => previous.unavailable ? { ...previous, unavailable: false } : previous);
    } catch { setView((previous) => ({ ...previous, unavailable: true })); }
  };

  useEffect(() => {
    saved.current = initialSaved;
    values.current = monitorDraftValues(initialSaved);
    draft.current = null;
    submissionActive.current = false;
    storage.current = null;
    let unavailable = false;
    try {
      storage.current = window.sessionStorage;
      clearMonitorDrafts(storage.current, scope);
      draft.current = readMonitorDraft(storage.current, scope, keyId, saved.current);
      if (draft.current) values.current = draft.current.values;
    } catch { unavailable = true; }
    setView({ identity, values: values.current, loaded: true, restored: draft.current !== null,
      conflict: draft.current !== null && !settingsMatch(draft.current.baseline, saved.current), unavailable });
  }, [scope, keyId]);

  const edit = (changes: Partial<MonitorDraftValues>) => {
    values.current = { ...values.current, ...changes };
    const candidate: MonitorDraft = { version: 1, values: values.current, baseline: draft.current?.baseline ?? saved.current,
      ...(draft.current?.pendingSave ? { pendingSave: draft.current.pendingSave } : {}) };
    draft.current = draftIsSettled(candidate, saved.current, submissionActive.current) ? null : candidate;
    persist(draft.current);
    setView((previous) => ({ ...previous, values: values.current,
      restored: draft.current !== null && previous.restored,
      conflict: draft.current !== null && !settingsMatch(draft.current.baseline, saved.current) }));
  };

  const reconcile = (next: MonitorSettings) => {
    saved.current = next;
    if (!draft.current || draftIsSettled(draft.current, next, submissionActive.current)) {
      draft.current = null;
      values.current = monitorDraftValues(next);
      persist(null);
    }
    setView((previous) => ({ ...previous, values: values.current,
      restored: draft.current !== null && previous.restored,
      conflict: draft.current !== null && !settingsMatch(draft.current.baseline, next) }));
  };

  const acknowledgeSave = (submitted: MonitorDraftValues) => {
    const next: MonitorSettings = { mode: submitted.mode, windowSeconds: Number(submitted.windowInput) };
    saved.current = next;
    submissionActive.current = false;
    draft.current = acknowledgeMonitorDraft(draft.current, next, values.current);
    if (draft.current) {
      // Edits made while an earlier save was pending belong to the next draft.
      persist(draft.current);
      setView((previous) => ({ ...previous, conflict: false }));
    } else {
      draft.current = null;
      values.current = monitorDraftValues(next);
      persist(null);
      setView((previous) => ({ ...previous, values: values.current, restored: false, conflict: false }));
    }
  };

  const beginSave = () => {
    const submitted = { ...values.current };
    submissionActive.current = true;
    draft.current = beginMonitorDraftSave(draft.current, saved.current, submitted);
    persist(draft.current);
    return submitted;
  };

  const failedSave = (outcomeUnknown: boolean) => {
    submissionActive.current = false;
    draft.current = failMonitorDraftSave(draft.current, outcomeUnknown);
    persist(draft.current);
  };

  const discard = () => {
    draft.current = null;
    values.current = monitorDraftValues(saved.current);
    persist(null);
    setView((previous) => ({ ...previous, values: values.current, restored: false, conflict: false }));
  };

  const activeIdentity = view.identity === identity;
  return { ...view, values: activeIdentity ? view.values : monitorDraftValues(initialSaved),
    loaded: activeIdentity && view.loaded, restored: activeIdentity && view.restored,
    conflict: activeIdentity && view.conflict, unavailable: activeIdentity && view.unavailable,
    unsaved: activeIdentity && draft.current !== null, edit, reconcile, acknowledgeSave, beginSave, failedSave, discard };
}
