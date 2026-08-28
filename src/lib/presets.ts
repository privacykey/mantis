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
  | "doc-rtf"
  | "folder-zip"
  | "creds-env"
  | "creds-aws"
  | "creds-netrc"
  | "creds-kubeconfig"
  | "browser-cookies"
  | "browser-bookmarks"
  | "vpn-ovpn"
  | "rdp-profile"
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
    id: "doc-rtf",
    label: "RTF document",
    blurb: "Fires when opened in Word, WordPad or TextEdit.",
    responseKind: "gif",
    dedupeWindowSeconds: 300,
    downloadFormat: "rtf",
    memoExample: "Board minutes (honeypot rtf)",
    deployHint:
      "RTF is plain text, so it survives inspection in an editor, and it skips the Protected View banner a downloaded .docx picks up.",
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
  // Credential and config stores. These fire when the URL inside them is USED,
  // not when the file is opened — an intruder who greps for secrets finds the
  // endpoint and calls it. Dedupe is off throughout: unlike a document that
  // gets re-opened by accident, every use of a bait credential is a real event.
  {
    id: "creds-env",
    label: ".env file",
    blurb: "Fires when something uses the endpoint or key inside it.",
    responseKind: "json",
    dedupeWindowSeconds: 0,
    // Was "md", which handed you a Markdown file when you asked for a .env —
    // it read as a document, not a credentials file, to anyone who found it.
    downloadFormat: "env",
    memoExample: "prod .env (bait creds)",
    deployHint:
      "Drop in a repo root, a deploy directory, or a home directory. Anything that reads it and calls the endpoint trips it.",
  },
  {
    id: "creds-aws",
    label: "AWS credentials",
    blurb: "~/.aws/credentials. Fires when a tool resolves against its endpoint.",
    responseKind: "json",
    dedupeWindowSeconds: 0,
    downloadFormat: "aws-credentials",
    memoExample: "aws credentials — build box",
    deployHint:
      "Save as ~/.aws/credentials. The bait profile sets endpoint_url, so an SDK or CLI pointed at it resolves to the canary instead of AWS. The keys are AWS's own documented examples — live nowhere.",
  },
  {
    id: "creds-netrc",
    label: ".netrc",
    blurb: "Auto-read by curl, wget and git — no one has to open it.",
    responseKind: "empty",
    dedupeWindowSeconds: 0,
    downloadFormat: "netrc",
    memoExample: "netrc — jump host",
    deployHint:
      "Save as ~/.netrc with mode 600. curl, wget, git and ftp consume it without being asked, so a request to the host authenticates straight from this file.",
  },
  {
    id: "creds-kubeconfig",
    label: "kubeconfig",
    blurb: "Cluster config with a bait API server. Fires when someone probes it.",
    responseKind: "json",
    dedupeWindowSeconds: 0,
    downloadFormat: "kubeconfig",
    memoExample: "kubeconfig — prod (bait)",
    deployHint:
      "Save as ~/.kube/config. Note kubectl appends its own API paths and will 404 — what this catches is the operator who finds the file and curls the server URL to see what cluster it is.",
  },
  {
    id: "browser-cookies",
    label: "Browser cookies",
    blurb: "cookies.txt session jar. Fires when a stolen cookie is replayed.",
    responseKind: "gif",
    dedupeWindowSeconds: 0,
    downloadFormat: "cookies",
    memoExample: "chrome cookies — laptop",
    deployHint:
      "Session cookies are what infostealers are actually after, because a stolen cookie skips MFA. The bait entry is scoped to this key's exact path, so a replayed jar registers as a hit.",
  },
  {
    id: "browser-bookmarks",
    label: "Browser bookmarks",
    blurb: "bookmarks.html. Fires on click, or on render if opened in a browser.",
    responseKind: "gif",
    dedupeWindowSeconds: 60,
    downloadFormat: "bookmarks",
    memoExample: "bookmarks — reception PC",
    deployHint:
      "The bait sits among real-looking internal links, where an intruder browsing for the VPN portal or admin console will find it. Its icon URL fires too if the file is opened in a browser.",
  },
  {
    id: "vpn-ovpn",
    label: "OpenVPN profile",
    blurb: "Discovery bait — fires when someone follows the URL inside it.",
    responseKind: "empty",
    dedupeWindowSeconds: 0,
    downloadFormat: "ovpn",
    memoExample: "corporate vpn profile",
    deployHint:
      "Does NOT beacon on its own — OpenVPN speaks its own protocol, not HTTP. The canary is the profile-update URL in the header, which is where someone who can't connect looks next.",
  },
  {
    id: "rdp-profile",
    label: "Remote Desktop profile",
    blurb: "Discovery bait — fires when someone follows the URL inside it.",
    responseKind: "empty",
    dedupeWindowSeconds: 0,
    downloadFormat: "rdp",
    memoExample: "rdp — prod jump host",
    deployHint:
      "Like the VPN profile, this does not beacon by itself. The canary sits in workspacefeedurl, a real RDP setting that legitimately holds an HTTPS URL.",
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
