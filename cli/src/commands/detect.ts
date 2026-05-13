import { homedir } from "node:os";
import { cronDetector } from "./detect/detectors/cron.js";
import { deepDetector } from "./detect/detectors/deep.js";
import { launchdDetector } from "./detect/detectors/launchd.js";
import {
  networkManagerDetector,
  systemdDetector,
} from "./detect/detectors/systemd.js";
import {
  shellHookFileDetector,
  shellRcDetector,
} from "./detect/detectors/shell-rc.js";
import { windowsTaskDetector } from "./detect/detectors/windows-task.js";
import { renderHuman, renderJson } from "./detect/render.js";
import type {
  Detector,
  DetectorContext,
  Finding,
  ScanSummary,
  Scope,
} from "./detect/types.js";
import { fail, isJsonMode } from "../lib/out.js";

const ALL_DETECTORS: Detector[] = [
  shellRcDetector,
  shellHookFileDetector,
  launchdDetector,
  systemdDetector,
  networkManagerDetector,
  windowsTaskDetector,
  cronDetector,
  deepDetector,
];

export type DetectOpts = {
  scope?: string;
  verbose?: boolean;
  json?: boolean;
  deep?: boolean;
};

export async function detectCmd(opts: DetectOpts): Promise<void> {
  const scope = normalizeScope(opts.scope);
  const ctx: DetectorContext = {
    scope,
    homeDir: homedir(),
    platform: process.platform,
    deep: Boolean(opts.deep),
  };

  const summary: ScanSummary = {
    scope,
    scanned: [],
    permissionDenied: [],
    errors: [],
    findings: [],
  };

  const applicable = ALL_DETECTORS.filter((d) => d.applicable(ctx));
  const results = await Promise.all(
    applicable.map(async (d) => {
      try {
        const r = await d.run(ctx);
        return { kind: d.kind, ...r };
      } catch (err) {
        return {
          kind: d.kind,
          findings: [] as Finding[],
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }),
  );

  for (const r of results) {
    summary.scanned.push(r.kind);
    summary.findings.push(...r.findings);
    if (r.permissionDenied) summary.permissionDenied.push(...r.permissionDenied);
    if (r.error) summary.errors.push({ detector: r.kind, error: r.error });
  }

  if (opts.json || isJsonMode()) {
    process.stdout.write(
      renderJson(summary, { verbose: Boolean(opts.verbose) }) + "\n",
    );
  } else {
    process.stdout.write(renderHuman(summary, { verbose: Boolean(opts.verbose) }));
  }

  // Exit code: 0 = clean, 2 = findings present. Distinguishes from a usage-error 1.
  if (summary.findings.length > 0) {
    process.exitCode = 2;
  }
}

function normalizeScope(raw: string | undefined): Scope {
  if (raw === "system" || raw === "all") return raw;
  if (raw === undefined || raw === "user") return "user";
  fail(`invalid --scope: ${raw}. Allowed: user, system, all.`);
}
