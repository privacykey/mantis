import { describe, expect, it } from "vitest";
import { ALL_FORMATS } from "@/lib/docs";
import {
  BULK_PRESETS,
  DEFAULT_PRESET_ID,
  PRESETS,
  getPreset,
  isPresetId,
} from "@/lib/presets";

const VALID_KINDS = ["gif", "empty", "json", "redirect", "html"];

describe("canary presets", () => {
  it("has unique ids", () => {
    const ids = PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every preset yields a response kind the create action accepts", () => {
    // A preset whose kind isn't in VALID_KINDS would silently fall back to
    // "gif" in createKeyAction, quietly ignoring the preset's intent.
    for (const p of PRESETS) {
      expect(VALID_KINDS, `${p.id} kind`).toContain(p.responseKind);
    }
  });

  it("every download format is a real generator format", () => {
    for (const p of PRESETS) {
      if (p.downloadFormat === null) continue;
      expect(ALL_FORMATS, `${p.id} format`).toContain(p.downloadFormat);
    }
  });

  it("keeps dedupe windows inside the action's accepted range", () => {
    for (const p of PRESETS) {
      expect(p.dedupeWindowSeconds).toBeGreaterThanOrEqual(0);
      expect(p.dedupeWindowSeconds).toBeLessThanOrEqual(86_400);
    }
  });

  it("alerts on every host event — login/sudo must not dedupe", () => {
    // Deduping a login alarm would swallow a second intrusion inside the
    // window, which is exactly the event you cannot afford to miss.
    for (const id of ["shell-login", "shell-sudo"] as const) {
      expect(getPreset(id).dedupeWindowSeconds, id).toBe(0);
    }
  });

  it("uses a rendering-safe response for document canaries", () => {
    // A document beacon is fetched by a renderer; anything but an image can
    // surface a broken-image glyph and tip off whoever opened the file.
    for (const id of ["doc-pdf", "doc-docx", "doc-xlsx", "doc-pptx"] as const) {
      expect(getPreset(id).responseKind, id).toBe("gif");
    }
  });

  it("falls back to the default preset for unknown or missing ids", () => {
    expect(getPreset(null).id).toBe(DEFAULT_PRESET_ID);
    expect(getPreset("nope").id).toBe(DEFAULT_PRESET_ID);
    expect(getPreset(undefined).id).toBe(DEFAULT_PRESET_ID);
  });

  it("guards isPresetId against arbitrary strings", () => {
    expect(isPresetId("doc-pdf")).toBe(true);
    expect(isPresetId("../../etc/passwd")).toBe(false);
  });

  it("bulk presets all produce a downloadable artifact", () => {
    expect(BULK_PRESETS.length).toBeGreaterThan(0);
    for (const p of BULK_PRESETS) {
      expect(p.downloadFormat, `${p.id}`).not.toBeNull();
    }
  });

  it("excludes apple-wallet from bulk (needs signing config per install)", () => {
    expect(BULK_PRESETS.some((p) => p.id === "apple-wallet")).toBe(false);
  });
});
