import { writeFileSync } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import type {
  Key,
  KeyWithDestinationResults,
  MantisClient,
  NotificationChannel,
} from "../lib/api.js";
import { c, emit, ExitCode, fail, isJsonMode, isQuiet } from "../lib/out.js";
import { withClient, type GlobalOpts } from "../lib/runner.js";
import { ALL_CHANNELS } from "../lib/channels.js";

export type BulkCreateOpts = GlobalOpts & {
  csv?: string;
  out?: string;
  memoColumn?: string;
  memoTemplate?: string;
  notify?: string[];
  notifyWebhook?: string[];
  notifyEmail?: string[];
  responseKind?: Key["response_kind"];
  responsePayload?: string;
  expiresAt?: string;
  concurrency?: string;
  failFast?: boolean;
  dryRun?: boolean;
};

const VALID_CHANNELS = ALL_CHANNELS;

const VALID_RESPONSE_KINDS: Key["response_kind"][] = [
  "gif",
  "empty",
  "json",
  "redirect",
  "html",
];

const OUTPUT_COLUMNS = [
  "mantis_memo",
  "mantis_id",
  "mantis_public_id",
  "mantis_url",
  "mantis_created_at",
  "mantis_error",
] as const;

type DestinationInput = { channel: NotificationChannel; target: string };
type CsvRecord = Record<string, string>;
type InputRow = { line: number; data: CsvRecord };
type RowResult = {
  row: CsvRecord;
  created: boolean;
  failed: boolean;
};
type LoadedCsv = {
  headers: string[];
  outputHeaders: string[];
  rows: InputRow[];
};
type PreparedRow = {
  memo: string;
  responseKind?: Key["response_kind"];
  responsePayload?: unknown;
  expiresAt?: string;
  destinations: DestinationInput[];
};

export async function bulkCreateCmd(opts: BulkCreateOpts): Promise<void> {
  if (!opts.csv) fail("--csv is required", ExitCode.Usage);
  if (!opts.out) fail("--out is required", ExitCode.Usage);

  const loaded = await loadCsv(opts.csv);
  const globalDestinations = parseGlobalDestinations(opts);
  const concurrency = parseConcurrency(opts.concurrency);

  if (loaded.rows.length === 0) {
    fail("input CSV has headers but no data rows");
  }

  if (opts.dryRun) {
    const results = loaded.rows.map((row) =>
      dryRunRow(row, opts, globalDestinations),
    );
    await writeResults(opts.out, loaded.outputHeaders, results);
    emitSummary(opts.out, results, true);
    if (results.some((result) => result.failed)) process.exitCode = 1;
    return;
  }

  await withClient(opts, async (client) => {
    const total = loaded.rows.length;
    const onProgress = makeProgressReporter(total);

    // Results land here as they complete (out of order under concurrency). The
    // SIGINT handler reads it so an interrupt still flushes a valid id↔URL
    // mapping — without it, keys created server-side would be unrecoverable
    // locally, and a re-run would duplicate them (createKey has no idempotency
    // key). Rows that never ran are marked so the operator sees what to retry.
    const sink: (RowResult | undefined)[] = new Array(total);
    const finalize = (uncreatedNote: string): RowResult[] =>
      loaded.rows.map((row, i) => sink[i] ?? rowError(row, uncreatedNote));

    let interrupted = false;
    const onSigint = () => {
      if (interrupted) return;
      interrupted = true;
      const results = finalize("interrupted before creation");
      const outPath = resolve(opts.out!);
      try {
        writeFileSync(
          outPath,
          writeCsv(loaded.outputHeaders, results.map((r) => r.row)),
          "utf8",
        );
      } catch {
        /* best effort on the way out */
      }
      const created = results.filter((r) => r.created).length;
      process.stderr.write(
        `\n${c.yellow("interrupted")} — wrote ${created}/${total} created so far to ${outPath}. ` +
          `Those keys exist on the server; a re-run will create duplicates.\n`,
      );
      process.exit(130);
    };
    process.on("SIGINT", onSigint);
    try {
      if (opts.failFast) {
        await createSequentially(
          client,
          loaded.rows,
          opts,
          globalDestinations,
          sink,
          onProgress,
        );
      } else {
        await mapLimit(
          loaded.rows,
          concurrency,
          (row) => createOne(client, row, opts, globalDestinations),
          sink,
          onProgress,
        );
      }
    } finally {
      process.removeListener("SIGINT", onSigint);
    }

    const results = finalize("not created");
    await writeResults(opts.out!, loaded.outputHeaders, results);
    emitSummary(opts.out!, results, false);
    if (results.some((result) => result.failed)) process.exitCode = 1;
  });
}

// Cap input CSV size so a pathological file (10 GB / unclosed quoted field)
// doesn't OOM the CLI. Override via MANTIS_BULK_CREATE_MAX_BYTES.
const DEFAULT_MAX_CSV_BYTES = 64 * 1024 * 1024; // 64 MiB

function maxCsvBytes(): number {
  const raw = process.env.MANTIS_BULK_CREATE_MAX_BYTES;
  if (!raw) return DEFAULT_MAX_CSV_BYTES;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1024) return DEFAULT_MAX_CSV_BYTES;
  return n;
}

// Strip absolute paths (Unix + Windows) to basenames so mantis_error CSV
// cells don't leak the operator's directory layout when the output is
// shared back to the supplier.
function redactErrMessage(message: string): string {
  return message.replace(
    /(?:[A-Za-z]:)?[\\/](?:[^\s\\/:'",]+[\\/])+([^\s\\/:'",]+)/g,
    "<$1>",
  );
}

async function loadCsv(path: string): Promise<LoadedCsv> {
  const abs = resolve(path);
  const base = basename(abs);
  let st;
  try {
    st = await stat(abs);
  } catch (err) {
    process.stderr.write(`bulk-create: stat failed for ${abs}\n`);
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`could not stat CSV ${base}: ${redactErrMessage(message)}`);
  }
  if (!st.isFile()) {
    throw new Error(`${base} is not a regular file`);
  }
  const cap = maxCsvBytes();
  if (st.size > cap) {
    throw new Error(
      `CSV ${base} is ${st.size} bytes; cap is ${cap}. Override with MANTIS_BULK_CREATE_MAX_BYTES if you trust the input.`,
    );
  }
  let raw = "";
  try {
    raw = await readFile(abs, "utf8");
  } catch (err) {
    process.stderr.write(`bulk-create: read failed for ${abs}\n`);
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`could not read CSV ${base}: ${redactErrMessage(message)}`);
  }

  const table = parseCsv(raw);
  if (table.length === 0) {
    fail("input CSV is empty");
  }

  const headerRow = table[0];
  if (!headerRow) {
    fail("input CSV is empty");
  }

  const headers = headerRow.map((value, index) =>
    (index === 0 ? value.replace(/^\uFEFF/, "") : value).trim(),
  );
  validateHeaders(headers);

  const rows = table
    .slice(1)
    .map((fields, index) => ({ fields, line: index + 2 }))
    .filter(({ fields }) => !isBlankRow(fields))
    .map(({ fields, line }) => {
      if (fields.length > headers.length) {
        fail(
          `row ${line} has ${fields.length} columns, but the header has ${headers.length}`,
        );
      }
      const data: CsvRecord = {};
      for (let i = 0; i < headers.length; i++) {
        const header = headers[i];
        if (!header) continue;
        data[header] = fields[i] ?? "";
      }
      return { line, data };
    });

  return {
    headers,
    outputHeaders: mergeOutputHeaders(headers),
    rows,
  };
}

function validateHeaders(headers: string[]): void {
  if (headers.length === 0 || headers.every((header) => !header)) {
    fail("input CSV needs a header row");
  }

  const seen = new Set<string>();
  for (const header of headers) {
    if (!header) fail("input CSV contains a blank header");
    const key = header.toLowerCase();
    if (seen.has(key)) {
      fail(`input CSV contains duplicate header "${header}"`);
    }
    seen.add(key);
  }
}

function mergeOutputHeaders(headers: string[]): string[] {
  const existing = new Set(headers.map((header) => header.toLowerCase()));
  const output = [...headers];
  for (const column of OUTPUT_COLUMNS) {
    if (!existing.has(column.toLowerCase())) output.push(column);
  }
  return output;
}

function dryRunRow(
  input: InputRow,
  opts: BulkCreateOpts,
  globalDestinations: DestinationInput[],
): RowResult {
  try {
    const prepared = prepareRow(input, opts, globalDestinations);
    return {
      row: withOutputColumns(input.data, {
        memo: prepared.memo,
      }),
      created: false,
      failed: false,
    };
  } catch (err) {
    return rowError(input, err);
  }
}

async function createSequentially(
  client: MantisClient,
  rows: InputRow[],
  opts: BulkCreateOpts,
  globalDestinations: DestinationInput[],
  sink: (RowResult | undefined)[],
  onProgress?: (result: RowResult) => void,
): Promise<void> {
  for (let i = 0; i < rows.length; i++) {
    const result = await createOne(client, rows[i]!, opts, globalDestinations);
    sink[i] = result;
    onProgress?.(result);
    if (result.failed) {
      for (let j = i + 1; j < rows.length; j++) {
        const skipped = rowError(
          rows[j]!,
          "skipped because --fail-fast stopped at an earlier row",
        );
        sink[j] = skipped;
        onProgress?.(skipped);
      }
      return;
    }
  }
}

async function createOne(
  client: MantisClient,
  input: InputRow,
  opts: BulkCreateOpts,
  globalDestinations: DestinationInput[],
): Promise<RowResult> {
  try {
    const prepared = prepareRow(input, opts, globalDestinations);
    const key = await client.createKey({
      memo: prepared.memo,
      ...(prepared.responseKind ? { response_kind: prepared.responseKind } : {}),
      ...(prepared.responsePayload !== undefined
        ? { response_payload: prepared.responsePayload }
        : {}),
      ...(prepared.destinations.length > 0
        ? { destinations: prepared.destinations }
        : {}),
      ...(prepared.expiresAt ? { expires_at: prepared.expiresAt } : {}),
    });

    return {
      row: withOutputColumns(input.data, {
        memo: prepared.memo,
        key,
      }),
      created: true,
      failed: false,
    };
  } catch (err) {
    return rowError(input, err);
  }
}

function prepareRow(
  input: InputRow,
  opts: BulkCreateOpts,
  globalDestinations: DestinationInput[],
): PreparedRow {
  const memo = memoForRow(input, opts);
  const responseKind = responseKindForRow(input, opts);
  const responsePayload = responsePayloadForRow(input, opts);
  const expiresAt = clean(input.data.expires_at) || clean(opts.expiresAt);
  const destinations = dedupeDestinations([
    ...globalDestinations,
    ...destinationsForRow(input),
  ]);

  return {
    memo,
    ...(responseKind ? { responseKind } : {}),
    ...(responsePayload !== undefined ? { responsePayload } : {}),
    ...(expiresAt ? { expiresAt } : {}),
    destinations,
  };
}

function memoForRow(input: InputRow, opts: BulkCreateOpts): string {
  if (opts.memoTemplate) {
    const memo = renderTemplate(opts.memoTemplate, input.data).trim();
    if (!memo) {
      throw new Error(
        `row ${input.line}: --memo-template rendered a blank memo`,
      );
    }
    return memo;
  }

  if (opts.memoColumn) {
    const memo = clean(input.data[opts.memoColumn]);
    if (!memo) {
      throw new Error(
        `row ${input.line}: missing memo value in column "${opts.memoColumn}"`,
      );
    }
    return memo;
  }

  for (const column of ["memo", "area", "name"]) {
    const memo = clean(input.data[column]);
    if (memo) return memo;
  }

  throw new Error(
    `row ${input.line}: add a memo, area, or name column, or pass --memo-template`,
  );
}

function responseKindForRow(
  input: InputRow,
  opts: BulkCreateOpts,
): Key["response_kind"] | undefined {
  const raw = clean(input.data.response_kind) || opts.responseKind;
  if (!raw) return undefined;
  if (!(VALID_RESPONSE_KINDS as readonly string[]).includes(raw)) {
    throw new Error(
      `row ${input.line}: response_kind must be one of ${VALID_RESPONSE_KINDS.join(", ")}`,
    );
  }
  return raw as Key["response_kind"];
}

function responsePayloadForRow(
  input: InputRow,
  opts: BulkCreateOpts,
): unknown {
  const raw = clean(input.data.response_payload) || opts.responsePayload;
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`row ${input.line}: response_payload must be valid JSON`);
  }
}

function renderTemplate(template: string, row: CsvRecord): string {
  return template.replace(
    /\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g,
    (_match, name: string) => row[name] ?? "",
  );
}

function parseGlobalDestinations(opts: BulkCreateOpts): DestinationInput[] {
  return dedupeDestinations([
    ...(opts.notify ?? []).map((spec) => parseNotifySpec(spec)),
    ...(opts.notifyWebhook ?? []).map((target) =>
      destinationFromAlias("webhook", target, "--notify-webhook"),
    ),
    ...(opts.notifyEmail ?? []).map((target) =>
      destinationFromAlias("email", target, "--notify-email"),
    ),
  ]);
}

function destinationsForRow(input: InputRow): DestinationInput[] {
  const out: DestinationInput[] = [];
  for (const spec of splitList(input.data.notify)) {
    out.push(parseNotifySpec(spec, `row ${input.line} notify`));
  }

  for (const channel of VALID_CHANNELS) {
    const column = `notify_${channel}`;
    for (const target of splitList(input.data[column])) {
      out.push(destinationFromAlias(channel, target, `row ${input.line} ${column}`));
    }
  }

  return out;
}

function parseNotifySpec(
  spec: string,
  label = "--notify",
): DestinationInput {
  const normalized = /^https?:\/\//i.test(spec) ? `webhook:${spec}` : spec;
  const idx = normalized.indexOf(":");
  if (idx <= 0) {
    throw new Error(
      `${label} expects <channel>:<target>. Channels: ${VALID_CHANNELS.join(", ")}`,
    );
  }
  const channelRaw = normalized.slice(0, idx);
  const target = normalized.slice(idx + 1);
  if (!(VALID_CHANNELS as readonly string[]).includes(channelRaw)) {
    throw new Error(
      `${label} has unknown channel "${channelRaw}". Valid: ${VALID_CHANNELS.join(", ")}`,
    );
  }
  return destinationFromAlias(
    channelRaw as NotificationChannel,
    target,
    label,
  );
}

function destinationFromAlias(
  channel: NotificationChannel,
  rawTarget: string,
  label: string,
): DestinationInput {
  const target = rawTarget.trim();
  if (!target) throw new Error(`${label}: empty ${channel} target`);
  return { channel, target };
}

function splitList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(/[;\n]/g)
    .map((part) => part.trim())
    .filter(Boolean);
}

function dedupeDestinations(destinations: DestinationInput[]): DestinationInput[] {
  const seen = new Set<string>();
  const out: DestinationInput[] = [];
  for (const destination of destinations) {
    const key = `${destination.channel}\0${destination.target}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(destination);
  }
  return out;
}

function withOutputColumns(
  original: CsvRecord,
  values: { memo?: string; key?: KeyWithDestinationResults; error?: string },
): CsvRecord {
  const row: CsvRecord = { ...original };
  for (const column of OUTPUT_COLUMNS) {
    row[column] = "";
  }
  row.mantis_memo = values.memo ?? "";
  if (values.key) {
    row.mantis_id = values.key.id;
    row.mantis_public_id = values.key.public_id;
    row.mantis_url = values.key.url;
    row.mantis_created_at = values.key.created_at;
  }
  row.mantis_error = values.error ?? "";
  return row;
}

function rowError(input: InputRow, err: unknown): RowResult {
  const message = err instanceof Error ? err.message : String(err);
  return {
    row: withOutputColumns(input.data, { error: redactErrMessage(message) }),
    created: false,
    failed: true,
  };
}

async function writeResults(
  outPath: string,
  headers: string[],
  results: RowResult[],
): Promise<void> {
  const abs = resolve(outPath);
  const rows = results.map((result) => result.row);
  await writeFile(abs, writeCsv(headers, rows), "utf8");
}

function emitSummary(
  outPath: string,
  results: RowResult[],
  dryRun: boolean,
): void {
  const abs = resolve(outPath);
  const total = results.length;
  const created = results.filter((result) => result.created).length;
  const failed = results.filter((result) => result.failed).length;
  const checked = total - failed;
  emit(
    () => {
      const count = dryRun ? checked : created;
      const noun = dryRun ? "rows" : "URLs";
      const verb = dryRun ? "checked" : "created";
      process.stdout.write(
        `${c.green("*")} ${verb} ${count}/${total} ${noun}; wrote ${abs}\n`,
      );
      if (failed > 0) {
        process.stdout.write(
          `${c.yellow("warning:")} ${failed} row${failed === 1 ? "" : "s"} failed; see mantis_error in the output CSV\n`,
        );
      }
    },
    { output: abs, total, created, failed, checked, dry_run: dryRun },
  );
}

// Live progress for the create loop. Stays on stderr so it never pollutes the
// --json/stdout contract or the results CSV, and is suppressed in JSON and
// quiet modes. On a TTY it rewrites a single line; when stderr is redirected
// (CI logs) it emits a throughput line every 50 rows so logs stay bounded.
function makeProgressReporter(
  total: number,
): ((result: RowResult) => void) | undefined {
  if (isJsonMode() || isQuiet()) return undefined;
  const isTty = process.stderr.isTTY;
  let done = 0;
  let failed = 0;
  let lastLogged = 0;
  return (result: RowResult) => {
    done += 1;
    if (result.failed) failed += 1;
    if (isTty) {
      const failPart = failed > 0 ? c.yellow(` (${failed} failed)`) : "";
      // Trailing spaces overwrite any longer previous line on rewrite.
      process.stderr.write(
        `\r${c.dim("creating")} ${done}/${total}${failPart}   `,
      );
      if (done >= total) process.stderr.write("\n");
    } else if (done >= total || done - lastLogged >= 50) {
      lastLogged = done;
      const failPart = failed > 0 ? ` (${failed} failed)` : "";
      process.stderr.write(`creating ${done}/${total}${failPart}\n`);
    }
  };
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
  sink: Array<R | undefined>,
  onProgress?: (result: R) => void,
): Promise<void> {
  let next = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      for (;;) {
        const index = next;
        next += 1;
        if (index >= items.length) return;
        const item = items[index];
        if (item === undefined) return;
        const result = await fn(item, index);
        sink[index] = result;
        onProgress?.(result);
      }
    },
  );
  await Promise.all(workers);
}

function parseConcurrency(raw: string | undefined): number {
  const value = raw ?? "4";
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 20) {
    fail("--concurrency must be an integer from 1 to 20", ExitCode.Usage);
  }
  return n;
}

function parseCsv(raw: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (inQuotes) {
      if (ch === "\"") {
        if (raw[i + 1] === "\"") {
          field += "\"";
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === "\"") {
      inQuotes = true;
      continue;
    }
    if (ch === ",") {
      row.push(field);
      field = "";
      continue;
    }
    if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      continue;
    }
    if (ch === "\r") {
      if (raw[i + 1] === "\n") i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      continue;
    }
    field += ch;
  }

  if (inQuotes) {
    fail("input CSV has an unterminated quoted field");
  }

  row.push(field);
  if (!isBlankRow(row) || rows.length === 0) rows.push(row);
  return rows;
}

function writeCsv(headers: string[], rows: CsvRecord[]): string {
  const lines = [
    headers.map(quoteCsvField).join(","),
    ...rows.map((row) =>
      headers.map((header) => quoteCsvField(row[header] ?? "")).join(","),
    ),
  ];
  return lines.join("\n") + "\n";
}

// Cell starts that Excel/Sheets/Numbers evaluate as a formula. Prefix `'`
// so the cell renders as text instead — OWASP CSV-injection mitigation.
const FORMULA_PREFIX = /^[=+\-@\t\r]/;

function quoteCsvField(value: string): string {
  const dangerous = FORMULA_PREFIX.test(value);
  const escaped = dangerous ? `'${value}` : value;
  if (!/[",\r\n]/.test(escaped) && escaped.trim() === escaped && !dangerous) {
    return escaped;
  }
  return `"${escaped.replace(/"/g, "\"\"")}"`;
}

function isBlankRow(row: string[]): boolean {
  return row.every((field) => field.trim() === "");
}

function clean(value: string | undefined): string {
  return value?.trim() ?? "";
}
