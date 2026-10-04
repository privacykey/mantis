export type MonitorSettings = { mode: "off" | "latch" | "window"; windowSeconds: number };
export type MonitorDraftValues = { mode: MonitorSettings["mode"]; windowInput: string };
export type MonitorDraft = { version: 1; values: MonitorDraftValues; baseline: MonitorSettings; pendingSave?: MonitorSettings };
export type DraftStorage = Pick<Storage, "length" | "key" | "getItem" | "setItem" | "removeItem">;

const PREFIX = "mantis:monitor-draft:v1:";

export function monitorDraftKey(scope: string, keyId: string): string {
  return `${PREFIX}${scope}:${keyId}`;
}

export function monitorDraftValues(saved: MonitorSettings): MonitorDraftValues {
  return { mode: saved.mode, windowInput: String(saved.windowSeconds) };
}

export function draftMatchesSaved(values: MonitorDraftValues, saved: MonitorSettings): boolean {
  return values.mode === saved.mode && values.windowInput.trim() !== "" &&
    Number(values.windowInput) === saved.windowSeconds;
}

export function settingsMatch(a: MonitorSettings, b: MonitorSettings): boolean {
  return a.mode === b.mode && a.windowSeconds === b.windowSeconds;
}

function isMode(value: unknown): value is MonitorSettings["mode"] {
  return value === "off" || value === "latch" || value === "window";
}

function isSavedSettings(value: unknown): value is MonitorSettings {
  if (!value || typeof value !== "object") return false;
  const settings = value as MonitorSettings;
  return isMode(settings.mode) && Number.isInteger(settings.windowSeconds) && settings.windowSeconds >= 30 && settings.windowSeconds <= 86_400;
}

export function draftIsSettled(draft: MonitorDraft, saved: MonitorSettings, submissionActive = false): boolean {
  return !submissionActive && draftMatchesSaved(draft.values, saved) &&
    (!draft.pendingSave || draftMatchesSaved(draft.values, draft.pendingSave));
}

function parseDraft(input: unknown): MonitorDraft | null {
  if (!input || typeof input !== "object") return null;
  const { version, values, baseline, pendingSave } = input as Partial<MonitorDraft>;
  if (version !== 1 || !values || !isSavedSettings(baseline) || !isMode(values.mode) ||
      typeof values.windowInput !== "string" || values.windowInput.length > 32 ||
      !/^(?:[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)?$/.test(values.windowInput) ||
      (values.windowInput !== "" && !Number.isFinite(Number(values.windowInput))) ||
      (pendingSave !== undefined && !isSavedSettings(pendingSave))) return null;
  // Retain only editable values and the saved baseline, even if storage was
  // altered. Empty/out-of-range number edits remain editable, never applied.
  return { version: 1, values: { mode: values.mode, windowInput: values.windowInput },
    baseline: { mode: baseline.mode, windowSeconds: baseline.windowSeconds },
    ...(pendingSave ? { pendingSave: { mode: pendingSave.mode, windowSeconds: pendingSave.windowSeconds } } : {}) };
}

export function readMonitorDraft(storage: DraftStorage, scope: string, keyId: string, saved: MonitorSettings): MonitorDraft | null {
  const key = monitorDraftKey(scope, keyId);
  const raw = storage.getItem(key);
  if (raw === null) return null;
  let draft: MonitorDraft | null = null;
  try { draft = parseDraft(JSON.parse(raw)); } catch { /* discard corrupt data */ }
  if (!draft || draftIsSettled(draft, saved)) {
    storage.removeItem(key);
    return null;
  }
  return draft;
}

export function writeMonitorDraft(storage: DraftStorage, scope: string, keyId: string, draft: MonitorDraft): void {
  const checked = parseDraft(draft);
  if (!checked) throw new Error("invalid monitor draft");
  storage.setItem(monitorDraftKey(scope, keyId), JSON.stringify(checked));
}

/** A successful earlier submission must not erase edits made while it was pending. */
export function acknowledgeMonitorDraft(draft: MonitorDraft | null, submitted: MonitorSettings, latest = draft?.values): MonitorDraft | null {
  return latest && !draftMatchesSaved(latest, submitted) ? { version: 1, values: latest, baseline: submitted } : null;
}

export function beginMonitorDraftSave(draft: MonitorDraft | null, saved: MonitorSettings, values: MonitorDraftValues): MonitorDraft {
  const submitted = { mode: values.mode, windowSeconds: Number(values.windowInput) };
  return { version: 1, values, baseline: draft?.baseline ?? saved,
    ...(values.windowInput !== "" && isSavedSettings(submitted) ? { pendingSave: submitted } : {}) };
}

export function failMonitorDraftSave(draft: MonitorDraft | null, outcomeUnknown: boolean): MonitorDraft | null {
  if (!draft || outcomeUnknown) return draft;
  return { version: 1, values: draft.values, baseline: draft.baseline };
}

export function removeMonitorDraft(storage: DraftStorage, scope: string, keyId: string): void {
  storage.removeItem(monitorDraftKey(scope, keyId));
}

/** Only this feature's records are cleared. sessionStorage keeps drafts per tab. */
export function clearMonitorDrafts(storage: DraftStorage, activeScope?: string): void {
  const remove: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (key?.startsWith(PREFIX) && (!activeScope || !key.startsWith(`${PREFIX}${activeScope}:`))) remove.push(key);
  }
  for (const key of remove) storage.removeItem(key);
}

/** Used after successful logout/expired-session redirect reaches the login page. */
export function clearBrowserMonitorDrafts(): void {
  try { clearMonitorDrafts(window.sessionStorage); } catch { /* browser storage may be blocked */ }
}
