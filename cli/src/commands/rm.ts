import { createInterface } from "node:readline/promises";
import { c, emit, fail, isJsonMode, safeText } from "../lib/out.js";
import { canPrompt } from "../lib/prompt.js";
import { announceResolved, resolveKeyRefDetailed } from "../lib/resolve.js";
import { withClient, type GlobalOpts } from "../lib/runner.js";

export type RmOpts = GlobalOpts & { yes?: boolean };

// Shared result shape so rm/disable/enable emit a consistent --json envelope.
export type MutationResult = {
  ref: string;
  id?: string;
  ok: boolean;
  error?: string;
};

export async function rmCmd(ids: string[], opts: RmOpts): Promise<void> {
  await withClient(opts, async (client) => {
    // Without a TTY (piped stdin, e.g. `mantis list --id-only | xargs mantis
    // rm`) the readline prompt would consume piped data as the answer and
    // silently delete nothing while exiting 0. Refuse loudly and tell the
    // caller to pass -y instead. Same for --json, where a [y/N] prompt is
    // meaningless.
    if (!opts.yes && (isJsonMode() || !canPrompt())) {
      fail(
        `refusing to delete ${ids.length} key(s) without confirmation — pass --yes (-y) to delete non-interactively`,
      );
    }

    // Resolve every ref exactly once, up front. The prompt and the DELETEs
    // below both work from these ids, so a key created while the prompt is
    // open — which changes what `last` means — can never be deleted in place
    // of the key that was confirmed.
    //
    // Best-effort per ref: one bad ref or failed delete doesn't abort the
    // rest, but any failure makes the command exit non-zero (kubectl/docker
    // pattern).
    const results: MutationResult[] = [];
    const memos = new Map<string, string>();
    let failed = 0;
    for (const ref of ids) {
      try {
        const resolved = await resolveKeyRefDetailed(client, ref);
        if (!opts.yes) {
          // The prompt shows each key's memo; a full UUID was passed through
          // without a lookup, so fetch it (this also catches a typo'd id).
          const key = resolved.key ?? (await client.getKey(resolved.id));
          memos.set(resolved.id, key.memo);
        } else if (resolved.key) {
          // No prompt to show it in: say which key a symbolic ref picked.
          announceResolved(ref, resolved.key);
        }
        results.push({ ref, id: resolved.id, ok: true });
      } catch (err) {
        // A lone ref at the prompt keeps withClient's full error handling
        // (exit code by error class, hint).
        if (!opts.yes && ids.length === 1) throw err;
        failed += 1;
        const error = err instanceof Error ? err.message : String(err);
        results.push({ ref, ok: false, error });
        if (!isJsonMode()) {
          process.stderr.write(`${c.red("✗")} ${safeText(ref)}: ${safeText(error)}\n`);
        }
      }
    }

    const targets = results.filter((r) => r.ok);
    if (!opts.yes && targets.length > 0) {
      let label: string;
      if (targets.length === 1) {
        const id = targets[0]!.id!;
        label = `key ${c.bold(safeText(id))} (${safeText(memos.get(id))})`;
      } else {
        for (const t of targets) {
          process.stderr.write(
            `  ${safeText(t.id)}  ${c.dim(safeText(memos.get(t.id!)))}\n`,
          );
        }
        label = `these ${targets.length} keys`;
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

    for (const r of targets) {
      try {
        await client.deleteKey(r.id!);
        if (!isJsonMode()) {
          process.stderr.write(`${c.green("✓")} deleted ${safeText(r.id)}\n`);
        }
      } catch (err) {
        failed += 1;
        r.ok = false;
        r.error = err instanceof Error ? err.message : String(err);
        if (!isJsonMode()) {
          process.stderr.write(`${c.red("✗")} ${safeText(r.ref)}: ${safeText(r.error)}\n`);
        }
      }
    }
    // In --json mode the human stderr lines above are suppressed; emit one
    // results envelope on stdout instead (shared shape with disable/enable).
    emit(() => {}, { action: "deleted", results, failed });
    if (failed > 0) process.exitCode = 1;
  });
}
