import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Detector, Finding } from "../types.js";
import { TRIGGER_URL_RE } from "../types.js";

const SERVICE_RE = /^(mantis|canary)(?:-wake)?(?:-[A-Za-z0-9]+)?\.service$/;
const NM_NAME_RE = /^99-(?:mantis|canary)-[A-Za-z0-9_-]+$/;

type ScanResult = { findings: Finding[]; permissionDenied: string[] };

export const systemdDetector: Detector = {
  kind: "systemd",
  applicable(ctx) {
    return ctx.platform === "linux";
  },
  async run(ctx) {
    const findings: Finding[] = [];
    const permissionDenied: string[] = [];

    const userDir = join(ctx.homeDir, ".config", "systemd", "user");
    const systemDir = "/etc/systemd/system";

    const dirs =
      ctx.scope === "system" || ctx.scope === "all"
        ? [userDir, systemDir]
        : [userDir];

    for (const dir of dirs) {
      const isSystem = dir === systemDir;
      const r = await scanSystemdDir(dir, isSystem);
      findings.push(...r.findings);
      permissionDenied.push(...r.permissionDenied);
    }

    return { findings, permissionDenied };
  },
};

async function scanSystemdDir(dir: string, isSystem: boolean): Promise<ScanResult> {
  const findings: Finding[] = [];
  const permissionDenied: string[] = [];

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { findings, permissionDenied };
    if (code === "EACCES" || code === "EPERM") {
      permissionDenied.push(dir);
      return { findings, permissionDenied };
    }
    return { findings, permissionDenied };
  }

  for (const name of entries) {
    if (!SERVICE_RE.test(name)) continue;
    const abs = join(dir, name);
    let content: string;
    try {
      content = await readFile(abs, "utf8");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EACCES" || code === "EPERM") {
        permissionDenied.push(abs);
        continue;
      }
      continue;
    }

    TRIGGER_URL_RE.lastIndex = 0;
    const urlMatch = TRIGGER_URL_RE.exec(content);
    const source = extractSourceHeader(content);
    const disableCmd = isSystem
      ? `sudo systemctl disable ${name} && sudo rm ${abs} && sudo systemctl daemon-reload`
      : `systemctl --user disable ${name} && rm ${abs} && systemctl --user daemon-reload`;

    findings.push({
      kind: "systemd",
      severity: "confirmed",
      path: abs,
      summary: `mantis systemd unit (${name})${isSystem ? "" : ", user scope"}`,
      url: urlMatch?.[0] ?? null,
      source,
      removeHint: disableCmd,
    });
  }

  return { findings, permissionDenied };
}

export const networkManagerDetector: Detector = {
  kind: "nm-dispatcher",
  applicable(ctx) {
    return ctx.platform === "linux" && (ctx.scope === "system" || ctx.scope === "all");
  },
  async run() {
    const findings: Finding[] = [];
    const permissionDenied: string[] = [];
    const dir = "/etc/NetworkManager/dispatcher.d";

    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return { findings, permissionDenied };
      if (code === "EACCES" || code === "EPERM") {
        return { findings, permissionDenied: [dir] };
      }
      return { findings, permissionDenied };
    }

    for (const name of entries) {
      if (!NM_NAME_RE.test(name)) continue;
      const abs = join(dir, name);
      let content = "";
      try {
        content = await readFile(abs, "utf8");
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "EACCES" || code === "EPERM") {
          permissionDenied.push(abs);
          continue;
        }
      }
      TRIGGER_URL_RE.lastIndex = 0;
      const urlMatch = TRIGGER_URL_RE.exec(content);
      findings.push({
        kind: "nm-dispatcher",
        severity: "confirmed",
        path: abs,
        summary: `mantis NetworkManager dispatcher script (${name})`,
        url: urlMatch?.[0] ?? null,
        source: extractSourceHeader(content),
        removeHint: `sudo rm ${abs}`,
      });
    }

    return { findings, permissionDenied };
  },
};

function extractSourceHeader(text: string): string | null {
  const m = /X-(?:Mantis|Canary)-Source:\s*([A-Za-z0-9_-]+)/i.exec(text);
  return m?.[1] ?? null;
}
