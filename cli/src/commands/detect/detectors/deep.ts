import { scanContentForPatterns } from "../patterns.js";
import type { Detector, Finding } from "../types.js";
import { walkText } from "../walk.js";

/**
 * Recursively scans $HOME for files containing mantis / canarytokens.* /
 * canary.tools URLs. Off by default — runs only with --deep.
 */
export const deepDetector: Detector = {
  kind: "deep",
  applicable(ctx) {
    return ctx.deep === true;
  },
  async run(ctx) {
    const findings: Finding[] = [];
    const permissionDenied: string[] = [];
    const start = Date.now();

    process.stderr.write(
      `[detect] --deep: walking ${ctx.homeDir} (scans .env / .envrc / .ssh\n` +
        `        contents for canary URLs; cancel with Ctrl-C if unintended)\n`,
    );

    const stats = await walkText({
      roots: [ctx.homeDir],
      onPermissionDenied: (p) => permissionDenied.push(p),
      onProgress: ({ scanned, bytes }) => {
        process.stderr.write(
          `[detect] --deep: scanned ${scanned} files (${formatBytes(bytes)})…\n`,
        );
      },
      onFile: ({ path, content }) => {
        const matches = scanContentForPatterns(content);
        for (const m of matches) {
          findings.push({
            kind: m.pattern.id,
            severity: m.pattern.severity,
            path,
            line: m.line,
            summary: `${path} contains a ${m.pattern.vendor}`,
            url: m.text,
            vendor: m.pattern.vendor,
            removeHint: `# review ${path}:${m.line} manually`,
          });
        }
      },
    });

    process.stderr.write(
      `[detect] --deep: scanned ${stats.scanned} files (${formatBytes(stats.bytes)}) in ${formatMs(Date.now() - start)}${stats.reachedLimit ? " — hit the file/byte cap, output may be incomplete" : ""}\n`,
    );

    return {
      findings,
      permissionDenied,
    };
  },
};

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const min = Math.floor(ms / 60_000);
  const sec = Math.floor((ms % 60_000) / 1000);
  return `${min}m${sec}s`;
}
