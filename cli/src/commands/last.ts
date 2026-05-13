import { c, emit, fail } from "../lib/out.js";
import { withClient, type GlobalOpts } from "../lib/runner.js";

/**
 * Print the most-recently-created key's id. Pipe-friendly:
 *
 *   mantis hits "$(mantis last)"
 *
 * Or use the literal token `last` as the id on any command — every command
 * that accepts <id> resolves it via resolveKeyRef:
 *
 *   mantis show last
 *   mantis open last
 *   mantis hits last --follow
 */
export async function lastCmd(opts: GlobalOpts): Promise<void> {
  await withClient(opts, async (client) => {
    const page = await client.listKeys({ limit: 1 });
    if (page.data.length === 0) {
      fail(
        "no keys exist yet. Run `mantis new \"memo\"` to create one.",
      );
    }
    const key = page.data[0]!;
    emit(
      () => {
        process.stdout.write(key.id + "\n");
        process.stderr.write(
          c.dim(`(${key.memo} — ${key.url})\n`),
        );
      },
      key,
    );
  });
}
