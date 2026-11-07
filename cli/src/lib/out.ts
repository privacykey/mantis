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

const wrap = (open: number | string) => (s: string) =>
  colorEnabled() ? `\x1b[${open}m${s}\x1b[0m` : s;

// Each color has one job across the CLI, so a glance at the color is a glance
// at the meaning:
//   red     tripped or failed          green   ok
//   yellow  warning or pending         cyan    something to run or open
//   bold    the thing to read first    dim     labels, hints, quiet rows
// A style ends with a full reset, so never nest a longer string inside
// another style — compose side by side, or use prose() for sentences.
export const c = {
  dim: wrap(2),
  bold: wrap(1),
  red: wrap(31),
  green: wrap(32),
  yellow: wrap(33),
  blue: wrap(34),
  magenta: wrap(35),
  cyan: wrap(36),
  alarm: wrap("1;31"),
  /** A warning count that must be seen: bold yellow. */
  warning: wrap("1;33"),
  /** Table headers: quiet and underlined, so the rows lead. */
  header: wrap("2;4"),
};

/** Whether styled output is on for this emission (flag, env, then TTY). */
export function colorOn(): boolean {
  return colorEnabled();
}

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

export type FailOpts = {
  /** One sentence on what to do next, printed dim under the error. */
  hint?: string;
  /** The `error` string for --json, when it differs from `message`. */
  json?: string;
  /**
   * `message` with the CLI's own styling (an echoed value in bold). Untrusted
   * text in it must already be safeText()'d; only SGR codes survive the escape.
   */
  styled?: string;
};

export function fail(message: string, code = 1, opts: FailOpts = {}): never {
  if (isJsonMode()) {
    process.stderr.write(jsonText({ error: opts.json ?? message }) + "\n");
  } else {
    process.stderr.write(formatError(opts.styled ?? message, opts.hint, Boolean(opts.styled)));
  }
  process.exit(code);
}

/**
 * `error: <message>` with an optional dim hint line underneath. Commands
 * written in back-ticks are rendered as commands. Messages routinely embed
 * server or filesystem text (API errors, paths), so everything is escaped.
 */
export function formatError(message: string, hint?: string, styled = false): string {
  const label = "error:";
  const pad = " ".repeat(label.length + 1);
  const width = Math.max(20, proseWidth(process.stderr) - pad.length);
  const lines: string[] = [];
  const safe = styled ? keepOnlySgr(message) : safeBlock(message);
  for (const raw of safe.split("\n")) {
    // A line the caller indented is laid out already (a list, a snippet).
    if (/^\s/.test(raw)) lines.push(raw);
    else lines.push(...wrapProse(raw, width));
  }
  let out = "";
  lines.forEach((line, i) => {
    const text = prose(line);
    if (i === 0) out += `${c.alarm(label)} ${text}\n`;
    else out += `${/^\s/.test(line) ? "" : pad}${text}\n`;
  });
  if (hint) {
    for (const line of wrapProse(safeBlock(hint), width)) {
      out += `${pad}${prose(line)}\n`;
    }
  }
  return out;
}

export type TableOpts = {
  /** Per-column alignment; numbers and ages read best right-aligned. */
  align?: ("left" | "right")[];
  /**
   * Style for a whole row (a dim duplicate, a quiet disabled key). The row's
   * own cell colors are dropped so the style holds across the line.
   */
  rowStyle?: (rowIndex: number) => ((s: string) => string) | undefined;
};

export function table(
  columns: string[],
  rows: (string | number | null | undefined)[][],
  opts: TableOpts = {},
): string {
  const bodyRows = rows.map((r) => r.map(formatCell));
  const all = headers ? [columns, ...bodyRows] : bodyRows;
  const widths = columns.map((_, i) =>
    Math.max(...all.map((row) => visibleLength(row[i] ?? ""))),
  );
  fitColumns(widths);
  const last = columns.length - 1;
  const fmt = (row: string[]) =>
    row
      .map((cell, i) => {
        const right = opts.align?.[i] === "right";
        const fitted = fitCell(cell, widths[i] ?? 0, right);
        // No trailing padding on the last column: nothing follows it.
        return i === last && !right ? fitted.trimEnd() : fitted;
      })
      .join("  ");
  const header = headers ? fmt(columns.map((name) => c.header(name))) : "";
  const body = bodyRows
    .map((row, i) => {
      const style = opts.rowStyle?.(i);
      return style ? style(stripAnsi(fmt(row))) : fmt(row);
    })
    .join("\n");
  return [header, body].filter(Boolean).join("\n");
}

function fitCell(s: string, width: number, right = false): string {
  if (visibleLength(s) > width) return truncate(s, width);
  return right ? padLeft(s, width) : padRight(s, width);
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

function padLeft(s: string, width: number): string {
  return " ".repeat(Math.max(0, width - visibleLength(s))) + s;
}

const ANSI_RE = /\x1b\[[0-9;]*m/g;

export function stripAnsi(s: string): string {
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

// ---------------------------------------------------------------------------
// Shared vocabulary. Every command draws state, time, labels and commands
// with the helpers below, so the same thing looks the same everywhere.
// ---------------------------------------------------------------------------

/**
 * The one set of status marks. Each is a single cell wide and has an ASCII
 * stand-in; a mark always sits beside a word or a count, never alone.
 */
export type Mark = "ok" | "fail" | "warn" | "pending" | "none";

const MARKS: Record<Mark, [string, string, (s: string) => string]> = {
  ok: ["✓", "+", c.green],
  fail: ["✗", "x", c.red],
  warn: ["⚠", "!", c.warning],
  pending: ["…", "~", c.warning],
  none: ["–", "-", c.dim],
};

export function mark(kind: Mark): string {
  const [unicodeMark, asciiMark, color] = MARKS[kind];
  return color(glyph(unicodeMark, asciiMark));
}

/** `● tripped`: the alarm, the loudest thing the CLI prints. ⚠ is a warning. */
export function tripped(text = "tripped"): string {
  return c.alarm(`${glyph("●", "!")} ${text}`);
}

export const arrow = {
  right: () => glyph("→", "->"),
  left: () => glyph("←", "<-"),
};

/** The separator between facts on one line. */
export function dot(): string {
  return glyph("·", "|");
}

/** A command the reader can run: cyan, or back-ticked when color is off. */
export function cmd(text: string): string {
  return colorEnabled() ? c.cyan(text) : `\`${text}\``;
}

/**
 * Style a sentence whose commands are written in back-ticks: the commands
 * become cmd(), the rest takes `base` (c.dim for hints). Use this instead of
 * wrapping a whole sentence in one style, which a nested style would cut off.
 */
export function prose(
  text: string,
  base: (s: string) => string = (s) => s,
): string {
  return text
    .split(/(`[^`\n]+`)/g)
    .map((part) => {
      if (!part) return "";
      if (part.length > 2 && part.startsWith("`") && part.endsWith("`")) {
        return cmd(part.slice(1, -1));
      }
      return base(part);
    })
    .join("");
}

/**
 * Width to wrap prose to: the terminal's, capped at 80 so lines stay
 * readable. Piped or redirected text is not wrapped at all, so one message
 * stays one line for whatever reads it next.
 */
export function proseWidth(
  stream: { isTTY?: boolean; columns?: number } = process.stdout,
): number {
  if (!stream.isTTY) return Number.MAX_SAFE_INTEGER;
  return Math.max(40, Math.min(stream.columns ?? 80, 100));
}

/**
 * Wrap plain prose on word boundaries. A back-ticked command is kept whole,
 * and measured the way prose() will draw it. Returns the lines, unstyled.
 */
export function wrapProse(text: string, width: number): string[] {
  const out: string[] = [];
  const ticks = colorEnabled() ? 2 : 0;
  for (const paragraph of text.split("\n")) {
    const words = paragraph.match(/`[^`\n]+`\S*|\S+/g) ?? [];
    let line = "";
    let lineWidth = 0;
    for (const word of words) {
      const w = word.length - (word.startsWith("`") ? ticks : 0);
      if (line && lineWidth + 1 + w > width) {
        out.push(line);
        line = word;
        lineWidth = w;
      } else {
        line = line ? `${line} ${word}` : word;
        lineWidth += (lineWidth ? 1 : 0) + w;
      }
    }
    out.push(line);
  }
  return out;
}

/** Print a dim hint (stderr), wrapped, with its commands drawn as commands. */
export function hintLines(text: string, indent = ""): string {
  const width = proseWidth(process.stderr) - indent.length;
  return wrapProse(text, width)
    .map((line) => `${indent}${prose(line)}\n`)
    .join("");
}

/**
 * The one absolute time format: `2026-11-06 02:26 UTC`. Seconds only where
 * two events have to be told apart (one hit in full). JSON keeps ISO.
 */
export function formatStamp(
  iso: string | null | undefined,
  opts: { seconds?: boolean } = {},
): string {
  if (!iso) return "-";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return safeText(iso);
  const text = d.toISOString();
  const time = `${text.slice(11, opts.seconds ? 19 : 16)} UTC`;
  // A stamp from today (UTC) needs no date; the relative age beside it says so.
  const today = new Date().toISOString().slice(0, 10);
  return text.slice(0, 10) === today ? time : `${text.slice(0, 10)} ${time}`;
}

/** formatTime() as a phrase: `4m ago`, `in 5m`, `now`. */
export function formatAgo(iso: string | null | undefined): string {
  if (!iso) return "-";
  const t = formatTime(iso);
  if (!/^\d+[smhd]$/.test(t)) return t;
  // In prose the seconds read as words: `3m 40s ago`, and a round `4m ago`.
  const diffMs = Date.now() - new Date(iso).getTime();
  if (diffMs >= 60_000 && diffMs < 600_000) {
    const m = Math.floor(diffMs / 60_000);
    const sec = Math.floor((diffMs % 60_000) / 1000);
    return sec ? `${m}m ${sec}s ago` : `${m}m ago`;
  }
  return `${t} ago`;
}

/**
 * formatTime() with seconds under ten minutes, in one fixed shape (`4m00s`,
 * `3m40s`) so hits seconds apart differ and a column keeps one format.
 */
export function formatAge(iso: string | null | undefined): string {
  if (!iso) return "-";
  const t = formatTime(iso);
  if (!/^\d+[smhd]$/.test(t)) return t;
  const diffMs = Date.now() - new Date(iso).getTime();
  if (diffMs >= 60_000 && diffMs < 600_000) {
    const m = Math.floor(diffMs / 60_000);
    const sec = Math.floor((diffMs % 60_000) / 1000);
    return `${m}m${String(sec).padStart(2, "0")}s`;
  }
  return t;
}

/** A server named for identification, not for opening: no scheme. */
export function hostOnly(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname.replace(/\/+$/, "")}${u.search}`;
  } catch {
    return url;
  }
}

/** A length of time in the largest units that fit: `1h`, `15m`, `1h 30m`. */
export function formatDuration(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) {
    return safeText(totalSeconds);
  }
  const units: [number, string][] = [
    [86_400, "d"],
    [3_600, "h"],
    [60, "m"],
    [1, "s"],
  ];
  const parts: string[] = [];
  let rest = Math.round(totalSeconds);
  for (const [size, suffix] of units) {
    if (rest >= size && parts.length < 2) {
      parts.push(`${Math.floor(rest / size)}${suffix}`);
      rest %= size;
    }
  }
  return parts.join(" ") || "0s";
}

/** Heading of a detail view: the name to read first, then a quiet aside. */
export function heading(main: string, aside?: string): string {
  return aside ? `${c.bold(main)}  ${c.dim(aside)}` : c.bold(main);
}

export type KvRow = [label: string, value: string | string[]];

/** Width of the `label:` column in every label and value block. */
export const KV_LABEL_WIDTH = 12;

/**
 * The one label and value block: dim `label:` in a fixed column, the value
 * beside it, continuation lines under the value. Returns text ending in a
 * newline, or "" when there are no rows.
 */
export function kv(rows: KvRow[], opts: { indent?: number } = {}): string {
  const indent = " ".repeat(opts.indent ?? 2);
  const width = Math.max(
    KV_LABEL_WIDTH,
    ...rows.map(([label]) => label.length + 1),
  );
  const under = " ".repeat(width + 1);
  let out = "";
  for (const [label, value] of rows) {
    const lines = Array.isArray(value) ? value : value.split("\n");
    lines.forEach((line, i) => {
      const lead = i === 0 ? `${c.dim(`${label}:`.padEnd(width))} ` : under;
      out += `${indent}${lead}${line}`.trimEnd() + "\n";
    });
  }
  return out;
}

/**
 * Cut a long value in the middle, keeping both ends (a URL's host and its
 * tail). Only on a terminal: piped output is never shortened.
 */
export function fitMiddle(s: string, max: number): string {
  if (!process.stdout.isTTY) return s;
  const text = keepOnlySgr(s);
  if (max < 8 || visibleLength(text) <= max) return text;
  const plain = stripAnsi(text);
  const ell = unicodeEnabled() ? "…" : "...";
  const tail = Math.min(6, Math.floor((max - ell.length) / 3));
  const head = max - ell.length - tail;
  return `${plain.slice(0, head)}${ell}${plain.slice(plain.length - tail)}`;
}

/**
 * A destination target with its secret hidden, on a terminal: the host and
 * the last six characters of a path that carries a token
 * (`hooks.slack.com/…6Lw0Zs`). A target without a token-like path segment
 * stays whole, and so does every target when output is piped or --json.
 */
export function maskSecretUrl(target: string): string {
  if (!process.stdout.isTTY) return target;
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return target;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return target;
  const path = url.pathname.replace(/\/+$/, "");
  const segments = path.split("/").filter(Boolean);
  const tokenLike = (seg: string) =>
    seg.length >= 20 || (seg.length >= 8 && /\d/.test(seg) && !/[-_.]/.test(seg));
  if (!segments.some(tokenLike)) return `${url.host}${path}${url.search}`;
  return `${url.host}/${glyph("…", "...")}${path.slice(-6)}`;
}

/**
 * A failure reason without the target the row above already names:
 * `HTTP 403 from siem.example (signature rejected)` → `HTTP 403 (signature
 * rejected)`; `relay access denied for ops@example` → `relay access denied`.
 */
export function withoutRepeat(reason: string, target: string): string {
  let host = "";
  try {
    host = new URL(target).host;
  } catch {
    // not a URL: the target itself is the only candidate
  }
  let out = reason;
  for (const t of [target, host].filter(Boolean)) {
    const esc = t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(`\\s(?:for|to|from|at)\\s${esc}(?=[\\s).,;:]|$)`), "");
  }
  return out;
}

/**
 * A table cell cut to `max` on a terminal, so one long value does not push
 * every column to the right; piped output keeps the whole value.
 */
export function cap(s: string, max: number): string {
  return process.stdout.isTTY ? truncate(s, max) : s;
}

/** Terminal width for layout that should use the room it has. */
export function termWidth(): number {
  return process.stdout.isTTY ? (process.stdout.columns ?? 80) : 80;
}
