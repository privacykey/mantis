import { spawnSync } from "node:child_process";
import type { Detector, Finding } from "../types.js";

const TASK_NAME_RE = /^\\(?:Mantis|Canary) (Logon|Wake|Network) /i;

export const windowsTaskDetector: Detector = {
  kind: "windows-task",
  applicable(ctx) {
    return ctx.platform === "win32";
  },
  async run() {
    const findings: Finding[] = [];

    // `/fo csv /v` gives a verbose CSV. The task names show up in column 0
    // (TaskName) as backslash-prefixed paths like `\Mantis Logon abc12345`.
    const res = spawnSync("schtasks", ["/query", "/fo", "csv", "/v"], {
      encoding: "utf8",
    });
    if (res.error || res.status !== 0) {
      return {
        findings,
        error:
          res.error?.message ??
          `schtasks exited ${res.status}: ${String(res.stderr).trim()}`,
      };
    }

    // CSV parsing is intentionally cheap — we only care about the first column.
    const lines = String(res.stdout).split(/\r?\n/);
    for (const line of lines) {
      if (!line) continue;
      const taskName = parseFirstCsvCell(line);
      if (!taskName) continue;
      if (!TASK_NAME_RE.test(taskName)) continue;

      findings.push({
        kind: "windows-task",
        severity: "confirmed",
        path: `schtasks://${taskName}`,
        summary: `mantis scheduled task (${taskName.trim()})`,
        removeHint: `schtasks /delete /tn "${taskName.replace(/^\\/, "")}" /f`,
      });
    }

    return { findings };
  },
};

function parseFirstCsvCell(line: string): string | null {
  // Cell is either "quoted, with commas" or unquoted. Find the first.
  if (line.startsWith('"')) {
    const end = line.indexOf('"', 1);
    if (end === -1) return null;
    return line.slice(1, end);
  }
  const comma = line.indexOf(",");
  if (comma === -1) return line;
  return line.slice(0, comma);
}
