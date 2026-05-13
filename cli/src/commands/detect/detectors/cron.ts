import { spawnSync } from "node:child_process";
import { userInfo } from "node:os";
import type { Detector, Finding } from "../types.js";
import { TRIGGER_URL_RE } from "../types.js";

const MANTIS_TOKEN_RE = /\b(mantis|canary)\b/i;

export const cronDetector: Detector = {
  kind: "cron",
  applicable(ctx) {
    return ctx.platform !== "win32";
  },
  async run() {
    const findings: Finding[] = [];
    const res = spawnSync("crontab", ["-l"], { encoding: "utf8" });
    // crontab -l exits 1 with "no crontab" on stderr if none — not an error.
    if (res.error) {
      // ENOENT = no crontab binary on this system; not a failure for our purposes.
      const code = (res.error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return { findings };
      return { findings, error: res.error.message };
    }
    if (!res.stdout) return { findings };

    const user = safeUser();
    const lines = String(res.stdout).split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      if (!line.trim() || line.trim().startsWith("#")) continue;

      let url: string | undefined;
      TRIGGER_URL_RE.lastIndex = 0;
      const urlMatch = TRIGGER_URL_RE.exec(line);
      if (urlMatch) url = urlMatch[0];

      const namesMatch = MANTIS_TOKEN_RE.test(line);
      if (!url && !namesMatch) continue;

      findings.push({
        kind: "cron",
        severity: url ? "confirmed" : "suspicious",
        path: `crontab://${user}`,
        line: i + 1,
        match: line.trim(),
        summary: `crontab line ${i + 1} references mantis/canary`,
        url: url ?? null,
        removeHint:
          `# review and edit your crontab:\ncrontab -e   # then delete line ${i + 1}`,
      });
    }
    return { findings };
  },
};

function safeUser(): string {
  try {
    return userInfo().username || "?";
  } catch {
    return "?";
  }
}
