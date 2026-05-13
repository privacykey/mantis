export type Scope = "user" | "system" | "all";

export type Severity = "confirmed" | "suspicious";

export type Finding = {
  /** Loose category — "shell-rc" | "shell-hook" | "launchd" | "systemd" | "nm-dispatcher" | "windows-task" | "cron" | one of the pattern ids from patterns.ts. */
  kind: string;
  severity: Severity;
  /** Filesystem path, or a synthetic identifier like "schtasks://<name>" / "crontab://<user>". */
  path: string;
  /** One-line description for human output. */
  summary: string;
  /** The trigger URL (mantis or third-party), if extractable. */
  url?: string | null;
  /** Vendor label for third-party tokens, e.g. "canarytokens.com (Thinkst)". */
  vendor?: string | null;
  /** X-Mantis-Source value (or X-Canary-Source for legacy installs), if extractable. */
  source?: string | null;
  /** 1-indexed line number, if a specific line in a file triggered the finding. */
  line?: number;
  /** Matched line text — only included with --verbose. */
  match?: string;
  /** Single shell command (or instructions) to remove the artifact. */
  removeHint: string;
  /** Non-fatal note (e.g. "permission denied — re-run with sudo"). */
  note?: string;
};

export type ScanSummary = {
  scope: Scope;
  scanned: string[];           // detector kinds that actually ran
  permissionDenied: string[];  // paths that returned EACCES
  errors: Array<{ detector: string; error: string }>;
  findings: Finding[];
  /** Set when --deep ran; lets the renderer mention the walk stats. */
  deepStats?: {
    filesScanned: number;
    bytesScanned: number;
    reachedLimit: boolean;
    durationMs: number;
  };
};

export type DetectorContext = {
  scope: Scope;
  homeDir: string;
  platform: NodeJS.Platform;
  /** Walk the filesystem for content patterns when set. Off by default. */
  deep: boolean;
  /** Override for $HOME — set in tests so we don't poke the real user's dotfiles. */
  homeOverride?: string;
};

export interface Detector {
  /** Stable identifier; appears in the scan summary's `scanned` list. */
  kind: string;
  applicable(ctx: DetectorContext): boolean;
  run(ctx: DetectorContext): Promise<{
    findings: Finding[];
    permissionDenied?: string[];
    error?: string;
  }>;
}

/**
 * Regex used to detect any mantis-style trigger URL — the public-id path
 * matches the server's SAFE_ID_RE (6–32 [A-Za-z0-9]) in
 * src/app/c/[publicId]/route.ts. Reused across detectors so the pattern lives
 * in one place.
 */
export const TRIGGER_URL_RE =
  /https?:\/\/[^\s"'`<>]+\/c\/[A-Za-z0-9]{6,32}(?:\?[A-Za-z0-9_=&-]+)?/g;

/**
 * Filename / label fragments that indicate a mantis or legacy canary
 * artifact. Used for high-confidence matches in launchd/systemd/etc.
 */
export const ARTIFACT_PREFIXES = ["mantis", "canary"] as const;
