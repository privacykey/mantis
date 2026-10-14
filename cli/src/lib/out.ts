export type ColorMode = "auto" | "always" | "never";

let colorMode: ColorMode = "auto";

export function setColorMode(mode: ColorMode): void {
  colorMode = mode;
}

// Evaluated per emission (not frozen at import) so a runtime `--color` flag and
// late TTY state take effect. Precedence: explicit --color always/never wins;
// otherwise NO_COLOR disables, FORCE_COLOR (any value but "0") forces on, and
// the default is "color only on a TTY".
function colorEnabled(): boolean {
  if (colorMode === "always") return true;
  if (colorMode === "never") return false;
  if (process.env.NO_COLOR) return false;
  const force = process.env.FORCE_COLOR;
  if (force !== undefined && force !== "0") return true;
  return Boolean(process.stdout.isTTY);
}

const wrap = (open: number) => (s: string) =>
  colorEnabled() ? `\x1b[${open}m${s}\x1b[0m` : s;

export const c = {
  dim: wrap(2),
  bold: wrap(1),
  red: wrap(31),
  green: wrap(32),
  yellow: wrap(33),
  blue: wrap(34),
  magenta: wrap(35),
  cyan: wrap(36),
};

// Text written by another principal (memos, destination targets, user agents,
// headers, host context, server error strings) or read from the filesystem
// (file names, matched lines) must reach the terminal inert. C0 controls
// (ESC, CR, LF, BS, BEL, ...), DEL, C1 controls, the Unicode line/paragraph
// separators and the bidi embedding/override/isolate controls become visible
// \uXXXX escapes, so the only control sequences a terminal ever sees are the
// SGR codes c.*() emits.
const UNSAFE_CLASS = String.raw`\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069`;
const UNSAFE_RE = new RegExp(`[${UNSAFE_CLASS}]`, "g");
const UNSAFE_BLOCK_RE = new RegExp(`\\r\\n|[${UNSAFE_CLASS}]`, "g");
const UNSAFE_KEEP_SGR_RE = new RegExp(`\\x1b\\[[0-9;]*m|[${UNSAFE_CLASS}]`, "g");
const JSON_RAW_RE = /[\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;

function visibleEscape(ch: string): string {
  return `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`;
}

/**
 * Make one API- or filesystem-sourced value safe to print on a single line.
 * Apply it BEFORE c.*() and truncate(), so the escapes are what gets colored
 * and measured.
 */
export function safeText(v: unknown): string {
  if (v === null || v === undefined) return "";
  return String(v).replace(UNSAFE_RE, visibleEscape);
}

/**
 * safeText() for multi-line text (error messages, installer snippets): tabs
 * and LF / CRLF line endings survive; everything else, a bare CR included, is
 * escaped.
 */
export function safeBlock(v: unknown): string {
  if (v === null || v === undefined) return "";
  return String(v).replace(UNSAFE_BLOCK_RE, (m) =>
    m === "\n" || m === "\t" || m === "\r\n" ? m : visibleEscape(m),
  );
}

/**
 * A payload destined for stdout (an installer snippet): byte-exact when
 * stdout is redirected to a file or pipe, escaped when it is a terminal.
 */
export function stdoutPayload(text: string): string {
  return process.stdout.isTTY ? safeBlock(text) : text;
}

// Last line of defense for strings that are already colored: keeps the SGR
// codes we emit and escapes every other control byte. Callers still run
// safeText() first — an SGR sequence smuggled in by untrusted text would
// survive this pass.
function keepOnlySgr(s: string): string {
  return s.replace(UNSAFE_KEEP_SGR_RE, (m) =>
    m.length > 1 ? m : visibleEscape(m),
  );
}

/**
 * JSON.stringify for stdout/stderr. JSON already escapes C0 controls; DEL, C1
 * (U+0080-U+009F) and the line-separator / bidi controls are left raw, and a
 * terminal showing the stream would act on them. Escaping them keeps the
 * output valid JSON that parses to the same value.
 */
export function jsonText(value: unknown, indent?: number): string {
  return (JSON.stringify(value, null, indent) ?? "null").replace(
    JSON_RAW_RE,
    visibleEscape,
  );
}

// Unicode glyphs (… · ← 🔐) turn to mojibake on dumb/legacy terminals. Default
// to on (Node is UTF-8 on modern systems); fall back to ASCII only on a clear
// signal: explicit opt-out (MANTIS_ASCII), TERM=dumb, or a non-UTF-8 locale.
export function unicodeEnabled(): boolean {
  if (process.env.MANTIS_ASCII) return false;
  if (process.env.TERM === "dumb") return false;
  const locale = process.env.LC_ALL || process.env.LC_CTYPE || process.env.LANG;
  if (locale && !/utf-?8/i.test(locale)) return false;
  return true;
}

/** A glyph with an ASCII fallback for terminals that can't render unicode. */
export function glyph(unicodeGlyph: string, ascii: string): string {
  return unicodeEnabled() ? unicodeGlyph : ascii;
}

/**
 * Process exit codes by error class, so scripts wrapping mantis can branch on
 * the failure kind (re-auth vs retry-with-backoff vs fix-the-command) instead
 * of string-matching stderr. 0 = success; 1 = generic/unclassified.
 *
 * Note: the `detect` command uses exit 2 for its own "artifacts found" signal
 * (grep-style), so this shared scheme deliberately skips 2.
 */
export const ExitCode = {
  Generic: 1,
  Usage: 3,
  Auth: 4,
  NotFound: 5,
  Network: 6,
  Server: 7,
} as const;

export type OutputMode = "table" | "json" | "wide";

let outputMode: OutputMode = "table";
let quiet = false;
let headers = true;

export function setJsonMode(on: boolean): void {
  if (on) outputMode = "json";
  else if (outputMode === "json") outputMode = "table";
}
export function isJsonMode(): boolean {
  return outputMode === "json";
}

export function setOutputMode(mode: OutputMode): void {
  outputMode = mode;
}

export function getOutputMode(): OutputMode {
  return outputMode;
}

export function isWideMode(): boolean {
  return outputMode === "wide";
}

export function setQuiet(on: boolean): void {
  quiet = on;
}

export function isQuiet(): boolean {
  return quiet;
}

export function setNoHeaders(on: boolean): void {
  headers = !on;
}

let debug = false;
export function setDebug(on: boolean): void {
  debug = on;
}
export function isDebug(): boolean {
  return (
    debug || Boolean(process.env.MANTIS_DEBUG) || Boolean(process.env.DEBUG)
  );
}

export function emit(human: () => void, jsonValue?: unknown): void {
  if (isJsonMode()) {
    process.stdout.write(jsonText(jsonValue ?? null) + "\n");
    return;
  }
  if (quiet) return;
  human();
}

export function fail(message: string, code = 1): never {
  if (isJsonMode()) {
    process.stderr.write(jsonText({ error: message }) + "\n");
  } else {
    // Messages routinely embed server or filesystem text (API errors, paths).
    process.stderr.write(`${c.red("error:")} ${safeBlock(message)}\n`);
  }
  process.exit(code);
}

export function table(
  columns: string[],
  rows: (string | number | null | undefined)[][],
): string {
  const bodyRows = rows.map((r) => r.map(formatCell));
  const all = headers ? [columns, ...bodyRows] : bodyRows;
  const widths = columns.map((_, i) =>
    Math.max(...all.map((row) => visibleLength(row[i] ?? ""))),
  );
  fitColumns(widths);
  const fmt = (row: string[]) =>
    row.map((cell, i) => fitCell(cell, widths[i] ?? 0)).join("  ");
  const header = headers ? c.bold(fmt(columns)) : "";
  const body = bodyRows.map(fmt).join("\n");
  return [header, body].filter(Boolean).join("\n");
}

function fitCell(s: string, width: number): string {
  return visibleLength(s) > width ? truncate(s, width) : padRight(s, width);
}

// Shrink the widest column(s) until the laid-out row fits the terminal — only
// when stdout is a TTY. Piped/redirected output keeps full widths so data is
// never silently truncated inside a pipeline.
function fitColumns(widths: number[]): void {
  if (!process.stdout.isTTY) return;
  const term = process.stdout.columns ?? 80;
  const gap = 2;
  const MIN = 5;
  const total = () =>
    widths.reduce((a, b) => a + b, 0) + gap * Math.max(0, widths.length - 1);
  while (total() > term) {
    let idx = -1;
    for (let i = 0; i < widths.length; i++) {
      if (widths[i]! > MIN && (idx === -1 || widths[i]! > widths[idx]!)) idx = i;
    }
    if (idx === -1) break; // every column already at the floor
    widths[idx]! -= 1;
  }
}

function formatCell(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return c.dim("-");
  return keepOnlySgr(String(v));
}

function padRight(s: string, width: number): string {
  return s + " ".repeat(Math.max(0, width - visibleLength(s)));
}

const ANSI_RE = /\x1b\[[0-9;]*m/g;

function stripAnsi(s: string): string {
  // intentionally narrow: only strips the CSI sequences we emit. Any other
  // control byte is counted as visible, which is what it becomes once
  // truncate() / table() have escaped it.
  return s.replace(ANSI_RE, "");
}

/** Visible (printable) length, ignoring the ANSI color codes we emit. */
export function visibleLength(s: string): number {
  return stripAnsi(s).length;
}

/**
 * Truncate to a visible width, appending an ellipsis ("…", or "..." when the
 * terminal can't render unicode). ANSI color codes are preserved and a reset
 * is re-appended if truncation cut inside a colored span, so colored table
 * cells stay balanced. Replaces the per-command truncate() helpers.
 *
 * Control bytes other than our own color codes never pass through: they are
 * escaped first (whether or not the string needs cutting), so they are
 * measured and cut as the visible text they become.
 */
export function truncate(s: string, max: number): string {
  if (max <= 0) return "";
  s = keepOnlySgr(s);
  if (visibleLength(s) <= max) return s;
  const ell = unicodeEnabled() ? "…" : "...";
  const budget = Math.max(0, max - ell.length);
  const codes = /\x1b\[[0-9;]*m/y;
  let out = "";
  let visible = 0;
  let open = false;
  for (let i = 0; i < s.length; ) {
    codes.lastIndex = i;
    const m = codes.exec(s);
    if (m) {
      out += m[0];
      open = m[0] !== "\x1b[0m";
      i += m[0].length;
      continue;
    }
    if (visible >= budget) break;
    out += s[i];
    visible += 1;
    i += 1;
  }
  out += ell;
  if (open) out += "\x1b[0m";
  return out;
}

export function formatTime(iso: string | null): string {
  if (!iso) return "-";
  const d = new Date(iso);
  // An unparseable timestamp is echoed back, so it has to be inert.
  if (Number.isNaN(d.getTime())) return safeText(iso);
  const now = Date.now();
  const diffMs = now - d.getTime();
  const abs = Math.abs(diffMs);
  const units: [number, string][] = [
    [60_000, "s"],
    [3_600_000, "m"],
    [86_400_000, "h"],
    [Number.POSITIVE_INFINITY, "d"],
  ];
  for (let i = 0; i < units.length; i++) {
    const [limit, suffix] = units[i]!;
    if (abs < limit) {
      const divisor = i === 0 ? 1_000 : units[i - 1]![0];
      const n = Math.round(abs / divisor);
      if (n === 0) return "now";
      // Past timestamps read as "5m" (ago); future ones (clock skew, a future
      // expires_at) read as "in 5m" rather than a confusing "-5m".
      return diffMs < 0 ? `in ${n}${suffix}` : `${n}${suffix}`;
    }
  }
  return safeText(iso);
}
