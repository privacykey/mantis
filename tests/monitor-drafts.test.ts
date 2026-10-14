import { describe, expect, it } from "vitest";
import {
  acknowledgeMonitorDraft, beginMonitorDraftSave, clearMonitorDrafts, draftIsSettled, failMonitorDraftSave, monitorDraftKey,
  readMonitorDraft, settingsMatch, writeMonitorDraft,
  type DraftStorage, type MonitorDraft, type MonitorSettings,
} from "@/lib/monitor-drafts";

class MemoryStorage implements DraftStorage {
  data = new Map<string, string>();
  get length() { return this.data.size; }
  key(index: number) { return [...this.data.keys()][index] ?? null; }
  getItem(key: string) { return this.data.get(key) ?? null; }
  setItem(key: string, value: string) { this.data.set(key, value); }
  removeItem(key: string) { this.data.delete(key); }
}

const firstSession = "a".repeat(64), nextSession = "b".repeat(64);
const key = "00000000-0000-4000-8000-000000000001", otherKey = "00000000-0000-4000-8000-000000000002";
const saved: MonitorSettings = { mode: "latch", windowSeconds: 300 };
const draft: MonitorDraft = { version: 1, values: { mode: "window", windowInput: "120" }, baseline: saved };

describe("monitor draft recovery", () => {
  it("recovers the unsaved choice after reload without changing saved settings", () => {
    const storage = new MemoryStorage();
    writeMonitorDraft(storage, firstSession, key, draft);
    const restored = readMonitorDraft(storage, firstSession, key, saved);
    expect(restored?.values).toEqual({ mode: "window", windowInput: "120" });
    expect(saved).toEqual({ mode: "latch", windowSeconds: 300 });
  });

  it("keeps a restored draft separate from newer saved settings for review", () => {
    const storage = new MemoryStorage();
    writeMonitorDraft(storage, firstSession, key, draft);
    const newer = { mode: "window", windowSeconds: 60 } as const;
    const restored = readMonitorDraft(storage, firstSession, key, newer)!;
    expect(restored.values.windowInput).toBe("120");
    expect(settingsMatch(restored.baseline, newer)).toBe(false);
  });

  it("reconciles an uncertain save that actually succeeded instead of restoring it for replay", () => {
    const storage = new MemoryStorage();
    writeMonitorDraft(storage, firstSession, key, draft);
    expect(readMonitorDraft(storage, firstSession, key, { mode: "window", windowSeconds: 120 })).toBeNull();
    expect(storage.length).toBe(0);
  });

  it("clears the acknowledged draft while retaining edits made during an earlier pending save", () => {
    const submitted = { mode: "window", windowSeconds: 120 } as const;
    expect(acknowledgeMonitorDraft(draft, submitted)).toBeNull();
    const later = { ...draft, values: { mode: "window" as const, windowInput: "180" } };
    const retained = acknowledgeMonitorDraft(later, submitted)!;
    expect(retained.values.windowInput).toBe("180");
    expect(retained.baseline).toEqual(submitted);
    const storage = new MemoryStorage();
    writeMonitorDraft(storage, firstSession, key, retained);
    expect(readMonitorDraft(storage, firstSession, key, submitted)?.values.windowInput).toBe("180");
  });

  it("isolates keys and every sign-in, including a fresh sign-in with the same API key", () => {
    const storage = new MemoryStorage();
    writeMonitorDraft(storage, firstSession, key, draft);
    expect(readMonitorDraft(storage, firstSession, otherKey, saved)).toBeNull();
    expect(readMonitorDraft(storage, nextSession, key, saved)).toBeNull();
    writeMonitorDraft(storage, nextSession, otherKey, draft);
    clearMonitorDrafts(storage, nextSession);
    expect(readMonitorDraft(storage, firstSession, key, saved)).toBeNull();
    expect(readMonitorDraft(storage, nextSession, otherKey, saved)?.values).toEqual(draft.values);
  });

  it("preserves a later return to the old saved value through pending polling, acknowledgement and reload", () => {
    // Saved A -> submit B -> edit back to A while B is still finishing.
    const submittedB = { mode: "window", windowSeconds: 120 } as const;
    const latestA: MonitorDraft = { version: 1, values: { mode: "latch", windowInput: "300" }, baseline: saved, pendingSave: submittedB };
    expect(draftIsSettled(latestA, saved, true)).toBe(false);
    expect(draftIsSettled({ ...draft, pendingSave: submittedB }, submittedB, true)).toBe(false);
    const storage = new MemoryStorage();
    writeMonitorDraft(storage, firstSession, key, latestA);
    // A reload before B's uncertain outcome must retain the later A choice.
    expect(readMonitorDraft(storage, firstSession, key, saved)?.values).toEqual(latestA.values);
    const acknowledged = acknowledgeMonitorDraft(latestA, submittedB, latestA.values)!;
    expect(acknowledged.baseline).toEqual(submittedB);
    expect(acknowledged.pendingSave).toBeUndefined();
    writeMonitorDraft(storage, firstSession, key, acknowledged);
    expect(readMonitorDraft(storage, firstSession, key, submittedB)?.values).toEqual(latestA.values);
    // Explicitly saving A resolves that newer draft; no mutation was replayed.
    expect(acknowledgeMonitorDraft(acknowledged, saved, latestA.values)).toBeNull();
  });

  it("logout clears only monitor drafts, preserving unrelated browser state", () => {
    const storage = new MemoryStorage();
    storage.setItem("theme", "dark");
    writeMonitorDraft(storage, firstSession, key, draft);
    writeMonitorDraft(storage, firstSession, otherKey, draft);
    clearMonitorDrafts(storage);
    expect([...storage.data.entries()]).toEqual([["theme", "dark"]]);
  });

  it("an invalid hidden number submission cannot poison later valid draft recovery", () => {
    const invalid = beginMonitorDraftSave(draft, saved, { mode: "off", windowInput: "120.5" });
    expect(invalid.pendingSave).toBeUndefined();
    const failed = failMonitorDraftSave(invalid, false)!;
    const corrected = { ...failed, values: { mode: "window" as const, windowInput: "180" } };
    const storage = new MemoryStorage();
    writeMonitorDraft(storage, firstSession, key, corrected);
    expect(readMonitorDraft(storage, firstSession, key, saved)?.values.windowInput).toBe("180");
  });

  it("removes pending metadata after a definite failure, preserving uncertain write outcomes for review", () => {
    const pending = beginMonitorDraftSave(null, saved, draft.values);
    expect(failMonitorDraftSave(pending, false)?.pendingSave).toBeUndefined();
    expect(failMonitorDraftSave(pending, true)?.pendingSave).toEqual({ mode: "window", windowSeconds: 120 });
  });

  it.each(["", "0", "120.5", "100000"])("preserves an unfinished number input %j as editable data", (windowInput) => {
    const storage = new MemoryStorage();
    writeMonitorDraft(storage, firstSession, key, { ...draft, values: { mode: "window", windowInput } });
    expect(readMonitorDraft(storage, firstSession, key, saved)?.values.windowInput).toBe(windowInput);
  });

  it.each(["not JSON", JSON.stringify({ ...draft, version: 99 }), JSON.stringify({ ...draft, values: { mode: "window", windowInput: "<script>" } })])("discards corrupt or unsupported storage without restoring it", (raw) => {
    const storage = new MemoryStorage();
    storage.setItem(monitorDraftKey(firstSession, key), raw);
    expect(readMonitorDraft(storage, firstSession, key, saved)).toBeNull();
    expect(storage.length).toBe(0);
  });

  it("serializes only editable monitor data and its saved baseline", () => {
    const storage = new MemoryStorage();
    writeMonitorDraft(storage, firstSession, key, { ...draft, credential: "must-not-be-stored" } as MonitorDraft);
    expect(storage.getItem(monitorDraftKey(firstSession, key))).not.toContain("must-not-be-stored");
    expect(JSON.parse(storage.getItem(monitorDraftKey(firstSession, key))!)).toEqual(draft);
  });
});
