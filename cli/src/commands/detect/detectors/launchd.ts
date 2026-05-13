import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Detector, Finding } from "../types.js";
import { TRIGGER_URL_RE } from "../types.js";

const LABEL_RE = /^(com\.(?:mantis|canary))\.(login|boot|wake|network)\.([A-Za-z0-9_-]+)$/;
const PLIST_NAME_RE = /^(com\.(?:mantis|canary))\.(login|boot|wake|network)\.[A-Za-z0-9_-]+\.plist$/;

type ScanResult = {
  findings: Finding[];
  permissionDenied: string[];
};

export const launchdDetector: Detector = {
  kind: "launchd",
  applicable(ctx) {
    return ctx.platform === "darwin";
  },
  async run(ctx) {
    const findings: Finding[] = [];
    const permissionDenied: string[] = [];

    const userPaths = [join(ctx.homeDir, "Library", "LaunchAgents")];
    const systemPaths = ["/Library/LaunchAgents", "/Library/LaunchDaemons"];

    const dirs =
      ctx.scope === "system" || ctx.scope === "all"
        ? [...userPaths, ...systemPaths]
        : userPaths;

    for (const dir of dirs) {
      const isSystem = dir.startsWith("/Library");
      const r = await scanDir(dir, isSystem);
      findings.push(...r.findings);
      permissionDenied.push(...r.permissionDenied);
    }

    return { findings, permissionDenied };
  },
};

async function scanDir(dir: string, isSystem: boolean): Promise<ScanResult> {
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
    if (!PLIST_NAME_RE.test(name)) continue;
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

    const labelMatch = LABEL_RE.exec(extractLabel(content) ?? "");
    const kindLabel = labelMatch ? labelMatch[2] : "unknown";
    TRIGGER_URL_RE.lastIndex = 0;
    const urlMatch = TRIGGER_URL_RE.exec(content);
    const source = extractSourceHeader(content);
    const unloadCmd = isSystem
      ? `sudo launchctl unload ${abs} && sudo rm ${abs}`
      : `launchctl unload ${abs} && rm ${abs}`;

    findings.push({
      kind: "launchd",
      severity: "confirmed",
      path: abs,
      summary: `mantis ${kindLabel} ${isSystem ? "LaunchDaemon" : "LaunchAgent"} (${name})`,
      url: urlMatch?.[0] ?? null,
      source,
      removeHint: unloadCmd,
    });
  }

  return { findings, permissionDenied };
}

function extractLabel(plistXml: string): string | null {
  // Minimal plist scrape — we only need <key>Label</key><string>...</string>.
  const m = /<key>\s*Label\s*<\/key>\s*<string>([^<]+)<\/string>/i.exec(plistXml);
  return m?.[1] ?? null;
}

function extractSourceHeader(text: string): string | null {
  const m = /X-(?:Mantis|Canary)-Source:\s*([A-Za-z0-9_-]+)/i.exec(text);
  return m?.[1] ?? null;
}
