import { readFile, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Detector, Finding } from "../types.js";
import { TRIGGER_URL_RE } from "../types.js";

const MAX_BYTES = 256 * 1024;

const RC_FILES = [
  ".bashrc",
  ".zshrc",
  ".bash_profile",
  ".profile",
  ".zprofile",
  ".config/fish/config.fish",
] as const;

const HOOK_FILES = [
  ".mantis.sh",
  ".mantis-sudo.sh",
  ".mantis-wakeup.sh",
  ".canary.sh",
  ".canary-sudo.sh",
  ".canary-wakeup.sh",
] as const;

const SOURCE_LINE_RE =
  /\bsource\s+(["']?)(~\/(?:\.mantis|\.canary)[^"'\s]*\1|\$HOME\/\.\.\.[^"'\s]*)/;
// Less strict — matches `source ~/.mantis.sh`, `source "~/.canary-sudo.sh"`,
// `. ~/.mantis.sh`, etc.
const SOURCE_OR_DOT_RE =
  /^\s*(?:source|\.)\s+["']?(~\/\.(?:mantis|canary)[^"'\s]*|\$HOME\/\.(?:mantis|canary)[^"'\s]*)["']?/m;

const HEADER_HINT_RE = /X-(?:Mantis|Canary)-(?:Source|User|Host|SSH-Client|SSH-Connection|TTY|Sudo-Cmd|Network-Interface):/i;

export const shellRcDetector: Detector = {
  kind: "shell-rc",
  applicable(ctx) {
    return ctx.platform !== "win32";
  },
  async run(ctx) {
    const findings: Finding[] = [];
    for (const rel of RC_FILES) {
      const abs = join(ctx.homeDir, rel);
      const content = await readUpTo(abs, MAX_BYTES);
      if (content === null) continue;
      const realAbs = await realpath(abs).catch(() => abs);
      findings.push(...scanRcContent(realAbs, content, rel));
    }
    return { findings };
  },
};

export const shellHookFileDetector: Detector = {
  kind: "shell-hook",
  applicable(ctx) {
    return ctx.platform !== "win32";
  },
  async run(ctx) {
    const findings: Finding[] = [];
    for (const rel of HOOK_FILES) {
      const abs = join(ctx.homeDir, rel);
      const s = await stat(abs).catch(() => null);
      if (!s || !s.isFile()) continue;
      const content = await readUpTo(abs, MAX_BYTES);
      if (content === null) continue;
      const url = firstTriggerUrl(content);
      const source = extractSource(content);
      findings.push({
        kind: "shell-hook",
        severity: "confirmed",
        path: abs,
        summary: `mantis shell hook (${rel})`,
        url: url ?? null,
        source,
        removeHint:
          `# remove hook + any source line that references it\n` +
          `rm ${abs}\n` +
          `# then delete the matching "source ${rel}" line from ~/.bashrc / ~/.zshrc / etc.`,
      });
    }

    // Also check ~/.wakeup — generic sleepwatcher hook name. Only flag if
    // its body contains mantis/canary markers, since a legitimate sleepwatcher
    // user might keep an unrelated wakeup script there.
    const wakeup = join(ctx.homeDir, ".wakeup");
    const wakeupStat = await stat(wakeup).catch(() => null);
    if (wakeupStat?.isFile()) {
      const content = await readUpTo(wakeup, MAX_BYTES);
      if (content && (HEADER_HINT_RE.test(content) || /\b(mantis|canary)\b/i.test(content))) {
        const url = firstTriggerUrl(content);
        findings.push({
          kind: "shell-hook",
          severity: "confirmed",
          path: wakeup,
          summary: "~/.wakeup contains a mantis-style ping (sleepwatcher hook)",
          url: url ?? null,
          source: extractSource(content),
          removeHint: `rm ${wakeup}    # or edit to remove the mantis lines if you use sleepwatcher for other things`,
        });
      }
    }

    return { findings };
  },
};

/**
 * Scans an rc-file body for:
 *   1. `source ~/.mantis.sh` (and variants) — confirmed
 *   2. inline `X-Mantis-Source:` / `X-Canary-Source:` header strings — confirmed
 *   3. fallback trigger-URL pattern — suspicious
 */
function scanRcContent(absPath: string, content: string, relName: string): Finding[] {
  const lines = content.split("\n");
  const findings: Finding[] = [];
  const seenLines = new Set<number>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const lineNo = i + 1;

    const sourceMatch = SOURCE_OR_DOT_RE.exec(line) ?? SOURCE_LINE_RE.exec(line);
    if (sourceMatch) {
      seenLines.add(lineNo);
      const sourced = sourceMatch[1] ?? "";
      findings.push({
        kind: "shell-rc",
        severity: "confirmed",
        path: absPath,
        line: lineNo,
        match: line.trim(),
        summary: `${relName} sources a mantis hook (${sourced})`,
        removeHint: `# delete the source line in ${absPath}:\nsed -i.bak '${lineNo}d' ${absPath}`,
      });
      continue;
    }

    if (HEADER_HINT_RE.test(line)) {
      seenLines.add(lineNo);
      findings.push({
        kind: "shell-rc",
        severity: "confirmed",
        path: absPath,
        line: lineNo,
        match: line.trim(),
        summary: `${relName} contains an inline X-Mantis-* / X-Canary-* header (curl snippet pasted directly)`,
        url: firstTriggerUrlIn(line),
        source: extractSource(line),
        removeHint: `# edit ${absPath} and remove the mantis curl block around line ${lineNo}`,
      });
    }
  }

  // Suspicious URL fallback: any /c/<id> URL that wasn't already part of
  // a confirmed match. Keeps noise low — only files we already opened.
  TRIGGER_URL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TRIGGER_URL_RE.exec(content)) !== null) {
    const before = content.slice(0, m.index);
    const lineNo = before.split("\n").length;
    if (seenLines.has(lineNo)) continue;
    findings.push({
      kind: "url-pattern",
      severity: "suspicious",
      path: absPath,
      line: lineNo,
      match: lines[lineNo - 1]?.trim(),
      summary: `${relName} contains a mantis-style trigger URL`,
      url: m[0],
      removeHint: `# review ${absPath}:${lineNo} manually`,
    });
  }

  return findings;
}

async function readUpTo(path: string, maxBytes: number): Promise<string | null> {
  try {
    const buf = await readFile(path, { encoding: null });
    if (buf.length > maxBytes) {
      return buf.subarray(0, maxBytes).toString("utf8");
    }
    return buf.toString("utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "EISDIR") return null;
    return null;
  }
}

function firstTriggerUrl(text: string): string | undefined {
  TRIGGER_URL_RE.lastIndex = 0;
  const m = TRIGGER_URL_RE.exec(text);
  return m?.[0];
}

function firstTriggerUrlIn(line: string): string | undefined {
  TRIGGER_URL_RE.lastIndex = 0;
  const m = TRIGGER_URL_RE.exec(line);
  return m?.[0];
}

function extractSource(text: string): string | null {
  const m = /X-(?:Mantis|Canary)-Source:\s*([A-Za-z0-9_-]+)/i.exec(text);
  return m?.[1] ?? null;
}
