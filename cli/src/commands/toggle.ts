import { c, emit, isJsonMode } from "../lib/out.js";
import { resolveKeyRef } from "../lib/resolve.js";
import { withClient, type GlobalOpts } from "../lib/runner.js";
import type { MutationResult } from "./rm.js";

export async function disableCmd(
  ids: string[],
  opts: GlobalOpts,
): Promise<void> {
  await toggle(ids, opts, true);
}

export async function enableCmd(
  ids: string[],
  opts: GlobalOpts,
): Promise<void> {
  await toggle(ids, opts, false);
}

// disable/enable are the same loop with the disabled flag flipped; sharing it
// keeps their --json envelope and best-effort behavior identical to each other
// and to `rm` (see rm.ts: MutationResult, { action, results, failed }).
async function toggle(
  ids: string[],
  opts: GlobalOpts,
  disabled: boolean,
): Promise<void> {
  const action = disabled ? "disabled" : "enabled";
  const tick = disabled ? c.yellow("✓") : c.green("✓");
  await withClient(opts, async (client) => {
    const results: MutationResult[] = [];
    let failed = 0;
    for (const ref of ids) {
      try {
        const fullId = await resolveKeyRef(client, ref);
        const t = await client.patchKey(fullId, { disabled });
        results.push({ ref, id: t.id, ok: true });
        if (!isJsonMode()) {
          process.stderr.write(`${tick} ${action} ${t.id}\n`);
        }
      } catch (err) {
        failed += 1;
        const error = err instanceof Error ? err.message : String(err);
        results.push({ ref, ok: false, error });
        if (!isJsonMode()) {
          process.stderr.write(`${c.red("✗")} ${ref}: ${error}\n`);
        }
      }
    }
    // In --json mode the human stderr lines above are suppressed; emit one
    // results envelope on stdout instead (shared shape with rm).
    emit(() => {}, { action, results, failed });
    if (failed > 0) process.exitCode = 1;
  });
}
