import type { ResponseKind } from "@/db/schema";
import type { FileFormat } from "@/lib/docs";

/**
 * Canary presets: "what am I planting?" → sensible defaults for everything
 * else. The dashboard's new-key and bulk flows pick a preset first and derive
 * the trigger response, dedupe window and download format from it, rather than
 * asking the operator to reason about response kinds up front. Every derived
 * value stays editable — a preset is a starting point, not a constraint.
 *
 * Why the response kind differs per preset:
 *   gif    — the fetcher is rendering something (a document beacon, an <img>,
 *            a CSS background). A 1×1 GIF is what it expects; anything else
 *            can show a broken-image glyph and tip off whoever opened it.
 *   empty  — the fetcher is a script (shell/login hooks, curl). Nothing
 *            renders it, so 204 is the smallest, quietest reply.
 *   json   — the caller is an automation (Home Assistant, IoT) that parses
 *            the body.
 */
export type PresetId =
  | "doc-pdf"
  | "doc-docx"
  | "doc-xlsx"
  | "doc-pptx"
  | "folder-zip"
  | "creds-env"
  | "shell-login"
  | "shell-sudo"
  | "web-pixel"
  | "nfc-tag"
  | "apple-wallet"
  | "custom";

export type Preset = {
  id: PresetId;
  label: string;
  /** One line, shown under the tile. Says what triggers it. */
  blurb: string;
  responseKind: ResponseKind;
  /** Seconds. Documents get re-opened; host events should page every time. */
  dedupeWindowSeconds: number;
  /** Artifact to hand back after minting, when the preset produces a file. */
  downloadFormat: FileFormat | null;
  /** Placeholder memo, also the default name stem in bulk mode. */
  memoExample: string;
  /** Shown on the key page after minting — how to actually deploy it. */
  deployHint: string;
};

export const PRESETS: Preset[] = [
  {
    id: "doc-pdf",
    label: "PDF document",
    blurb: "Fires when the PDF is opened in a reader that loads remote content.",
    responseKind: "gif",
    dedupeWindowSeconds: 300,
    downloadFormat: "pdf",
    memoExample: "Q4 financials (honeypot PDF)",
    deployHint:
      "Drop the PDF somewhere it has no business being opened — a share, a desktop, an archive.",
  },
  {
    id: "doc-docx",
    label: "Word document",
    blurb: "Fires when the .docx is opened in Word.",
    responseKind: "gif",
    dedupeWindowSeconds: 300,
    downloadFormat: "docx",
    memoExample: "Salaries 2026 (honeypot docx)",
    deployHint:
      "Place it in a folder that only an intruder would browse. Word loads the beacon on open.",
  },
  {
    id: "doc-xlsx",
    label: "Excel spreadsheet",
    blurb: "Fires when the .xlsx is opened in Excel.",
    responseKind: "gif",
    dedupeWindowSeconds: 300,
    downloadFormat: "xlsx",
    memoExample: "Payroll export (honeypot xlsx)",
    deployHint: "Excel loads the beacon on open, before any macro prompt.",
  },
  {
    id: "doc-pptx",
    label: "PowerPoint deck",
    blurb: "Fires when the .pptx is opened.",
    responseKind: "gif",
    dedupeWindowSeconds: 300,
    downloadFormat: "pptx",
    memoExample: "Board deck (honeypot pptx)",
    deployHint: "Opens the beacon on first slide render.",
  },
  {
    id: "folder-zip",
    label: "Honey folder (zip)",
    blurb: "A zip of bait files that beacons when the folder is browsed.",
    responseKind: "gif",
    dedupeWindowSeconds: 300,
    downloadFormat: "folder",
    memoExample: "backups (honey folder)",
    deployHint:
      "Unzip it where a browsing intruder would land. Explorer/Finder trip the beacon on preview.",
  },
  {
    id: "creds-env",
    label: "Fake credentials file",
    blurb: "A .env-style file; fires when the bait URL inside it is used.",
    responseKind: "json",
    dedupeWindowSeconds: 0,
    downloadFormat: "md",
    memoExample: "prod .env (bait creds)",
    deployHint:
      "Anything that reads the file and calls the endpoint trips it. Dedupe is off so every use pages you.",
  },
  {
    id: "shell-login",
    label: "SSH / login alarm",
    blurb: "Fires on interactive login. Installed as a shell hook.",
    responseKind: "empty",
    dedupeWindowSeconds: 0,
    downloadFormat: null,
    memoExample: "ssh login — web01",
    deployHint:
      "Use the installers on the key page (shell / macos-login / windows-logon). One key per host is best practice.",
  },
  {
    id: "shell-sudo",
    label: "sudo / privilege alarm",
    blurb: "Fires when sudo runs. Reports the command and user.",
    responseKind: "empty",
    dedupeWindowSeconds: 0,
    downloadFormat: null,
    memoExample: "sudo — web01",
    deployHint:
      "Install the shell-sudo hook from the key page. Every invocation pages you (dedupe off).",
  },
  {
    id: "web-pixel",
    label: "Web page / tracking pixel",
    blurb: "Fires when a page embeds and renders the URL.",
    responseKind: "gif",
    dedupeWindowSeconds: 60,
    downloadFormat: "html",
    memoExample: "staging admin page pixel",
    deployHint:
      "Embed as <img> or a CSS background. The css-background installer on the key page gives you a snippet.",
  },
  {
    id: "nfc-tag",
    label: "NFC tag",
    blurb: "Fires when a phone taps the tag.",
    responseKind: "gif",
    dedupeWindowSeconds: 60,
    downloadFormat: "nfc-label",
    memoExample: "server rack tag",
    deployHint: "Write the URL to the tag, then stick the printed label on the asset.",
  },
  {
    id: "apple-wallet",
    label: "Apple Wallet pass",
    blurb: "Fires on install, fetch and removal. Needs wallet settings configured.",
    responseKind: "gif",
    dedupeWindowSeconds: 60,
    downloadFormat: "apple-wallet",
    memoExample: "building access pass",
    deployHint:
      "Requires Apple Wallet signing in settings. The pass calls back on install/uninstall as well as on trigger.",
  },
  {
    id: "custom",
    label: "Custom",
    blurb: "Start from a blank key and choose everything yourself.",
    responseKind: "gif",
    dedupeWindowSeconds: 60,
    downloadFormat: null,
    memoExample: "",
    deployHint: "",
  },
];

export const DEFAULT_PRESET_ID: PresetId = "doc-pdf";

export function getPreset(id: string | null | undefined): Preset {
  return (
    PRESETS.find((p) => p.id === id) ??
    PRESETS.find((p) => p.id === DEFAULT_PRESET_ID)!
  );
}

export function isPresetId(v: string): v is PresetId {
  return PRESETS.some((p) => p.id === v);
}

/** Presets that mint a downloadable artifact — the ones bulk mode can zip. */
export const BULK_PRESETS: Preset[] = PRESETS.filter(
  (p) => p.downloadFormat !== null && p.id !== "apple-wallet",
);
