import { createInterface } from "node:readline/promises";
import { c, fail, isJsonMode } from "../lib/out.js";
import { canPrompt } from "../lib/prompt.js";
import { resolveKeyRef } from "../lib/resolve.js";
import { withClient, type GlobalOpts } from "../lib/runner.js";

export type RmOpts = GlobalOpts & { yes?: boolean };

export async function rmCmd(ids: string[], opts: RmOpts): Promise<void> {
  await withClient(opts, async (client) => {
    if (!opts.yes) {
      // Without a TTY (piped stdin, e.g. `mantis list --id-only | xargs mantis
      // rm`) the readline prompt would consume piped data as the answer and
      // silently delete nothing while exiting 0. Refuse loudly and tell the
      // caller to pass -y instead. Same for --json, where a [y/N] prompt is
      // meaningless.
      if (isJsonMode() || !canPrompt()) {
        fail(
          `refusing to delete ${ids.length} key(s) without confirmation — pass --yes (-y) to delete non-interactively`,
        );
      }
      // For a single key, resolve it so the prompt can show the memo (the
      // common interactive case); for a batch, confirm by count.
      let label: string;
      if (ids.length === 1) {
        const key = await client.getKey(await resolveKeyRef(client, ids[0]!));
        label = `key ${c.bold(key.id.slice(0, 8))} (${key.memo})`;
      } else {
        label = `${ids.length} keys`;
      }
      const rl = createInterface({
        input: process.stdin,
        output: process.stderr,
      });
      try {
        const answer = (await rl.question(`Delete ${label}? [y/N] `))
          .trim()
          .toLowerCase();
        if (answer !== "y" && answer !== "yes") {
          return fail("cancelled", 0);
        }
      } finally {
        rl.close();
      }
    }

    // Best-effort per id: one bad ref or failed delete doesn't abort the rest,
    // but any failure makes the command exit non-zero (kubectl/docker pattern).
    let failed = 0;
    for (const ref of ids) {
      try {
        const fullId = await resolveKeyRef(client, ref);
        await client.deleteKey(fullId);
        process.stderr.write(`${c.green("✓")} deleted ${fullId}\n`);
      } catch (err) {
        failed += 1;
        process.stderr.write(
          `${c.red("✗")} ${ref}: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    }
    if (failed > 0) process.exitCode = 1;
  });
}
