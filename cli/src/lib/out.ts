const useColor = process.stdout.isTTY && !process.env.NO_COLOR;

const wrap = (open: number) => (s: string) =>
  useColor ? `\x1b[${open}m${s}\x1b[0m` : s;

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

export function emit(human: () => void, jsonValue?: unknown): void {
  if (isJsonMode()) {
    process.stdout.write(JSON.stringify(jsonValue ?? null) + "\n");
    return;
  }
  if (quiet) return;
  human();
}

export function fail(message: string, code = 1): never {
  if (isJsonMode()) {
    process.stderr.write(JSON.stringify({ error: message }) + "\n");
  } else {
    process.stderr.write(`${c.red("error:")} ${message}\n`);
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
    Math.max(...all.map((row) => stripAnsi(row[i] ?? "").length)),
  );
  const fmt = (row: string[]) =>
    row.map((cell, i) => padRight(cell, widths[i] ?? 0)).join("  ");
  const header = headers ? c.bold(fmt(columns)) : "";
  const body = bodyRows.map(fmt).join("\n");
  return [header, body].filter(Boolean).join("\n");
}

function formatCell(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return c.dim("-");
  return String(v);
}

function padRight(s: string, width: number): string {
  const visible = stripAnsi(s).length;
  return s + " ".repeat(Math.max(0, width - visible));
}

function stripAnsi(s: string): string {
  // intentionally narrow: only strips the CSI sequences we emit
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

export function formatTime(iso: string | null): string {
  if (!iso) return "-";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
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
      const n = Math.round(diffMs / divisor);
      return n === 0 ? "now" : `${n > 0 ? "" : ""}${n}${suffix}`;
    }
  }
  return iso;
}
