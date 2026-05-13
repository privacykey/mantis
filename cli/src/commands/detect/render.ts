import { c } from "../../lib/out.js";
import type { Finding, ScanSummary } from "./types.js";

export function renderHuman(
  summary: ScanSummary,
  opts: { verbose: boolean },
): string {
  if (summary.findings.length === 0) {
    const lines = [
      `${c.green("✓")} no mantis-style artifacts detected on this machine.`,
      "",
      `  ${c.dim("scanned:")} ${summary.scanned.join(", ") || "(none)"}`,
      `  ${c.dim("scope:  ")} ${summary.scope}`,
    ];
    appendNonFindings(lines, summary);
    return lines.join("\n") + "\n";
  }

  const lines: string[] = [];
  lines.push(
    `${c.yellow("⚠")} ${summary.findings.length} mantis-style artifact${
      summary.findings.length === 1 ? "" : "s"
    } found on this machine:`,
  );
  lines.push("");

  // Stable order: confirmed first, then suspicious; within each, by kind, then path.
  const sorted = [...summary.findings].sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === "confirmed" ? -1 : 1;
    if (a.kind !== b.kind) return a.kind.localeCompare(b.kind);
    return a.path.localeCompare(b.path);
  });

  for (const f of sorted) {
    const sev =
      f.severity === "confirmed"
        ? c.red("✗ ") + c.dim("confirmed")
        : c.yellow("? ") + c.dim("suspicious");
    lines.push(`  ${sev}  ${c.bold(f.kind)}`);
    lines.push(`    ${c.dim("path:    ")} ${formatPath(f.path)}${f.line ? `:${f.line}` : ""}`);
    lines.push(`    ${c.dim("summary: ")} ${f.summary}`);
    if (f.vendor) lines.push(`    ${c.dim("vendor:  ")} ${f.vendor}`);
    if (f.url) lines.push(`    ${c.dim("matched: ")} ${c.cyan(f.url)}`);
    if (f.source) lines.push(`    ${c.dim("source:  ")} ${f.source}`);
    if (opts.verbose && f.match) {
      lines.push(`    ${c.dim("match:   ")} ${f.match}`);
    }
    lines.push(`    ${c.dim("remove:  ")} ${f.removeHint.split("\n").join(`\n               `)}`);
    if (f.note) lines.push(`    ${c.dim("note:    ")} ${f.note}`);
    lines.push("");
  }

  appendNonFindings(lines, summary);
  lines.push("");
  lines.push(
    c.dim(
      "If you didn't install these yourself, someone else is using mantis to track this machine.",
    ),
  );
  if (!opts.verbose) {
    lines.push(c.dim("Run again with --verbose to see the matched lines."));
  }
  return lines.join("\n") + "\n";
}

export function renderJson(
  summary: ScanSummary,
  opts: { verbose: boolean } = { verbose: false },
): string {
  return JSON.stringify(
    {
      scope: summary.scope,
      scanned: summary.scanned,
      permission_denied: summary.permissionDenied,
      errors: summary.errors,
      findings: summary.findings.map((f) => serialize(f, opts.verbose)),
    },
    null,
    2,
  );
}

function serialize(f: Finding, verbose: boolean) {
  return {
    kind: f.kind,
    severity: f.severity,
    path: f.path,
    line: f.line ?? null,
    summary: f.summary,
    url: f.url ?? null,
    vendor: f.vendor ?? null,
    source: f.source ?? null,
    // `match` carries the full source line — gated on --verbose because it
    // can include secrets adjacent to the matched URL.
    match: verbose ? (f.match ?? null) : null,
    remove_hint: f.removeHint,
    note: f.note ?? null,
  };
}

function appendNonFindings(lines: string[], summary: ScanSummary): void {
  if (summary.permissionDenied.length > 0) {
    lines.push("");
    lines.push(
      `  ${c.yellow("note:")} permission denied on ${summary.permissionDenied.length} path${
        summary.permissionDenied.length === 1 ? "" : "s"
      } — re-run with sudo to scan system locations.`,
    );
    for (const p of summary.permissionDenied.slice(0, 5)) {
      lines.push(`    ${c.dim("•")} ${p}`);
    }
    if (summary.permissionDenied.length > 5) {
      lines.push(`    ${c.dim(`… and ${summary.permissionDenied.length - 5} more`)}`);
    }
  }
  if (summary.errors.length > 0) {
    lines.push("");
    for (const e of summary.errors) {
      lines.push(`  ${c.red("error:")} ${e.detector}: ${e.error}`);
    }
  }
}

function formatPath(p: string): string {
  return p;
}
