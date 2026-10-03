import { c, emit, fail, safeText } from "../lib/out.js";
import { withClient, type GlobalOpts } from "../lib/runner.js";

/**
 * Print the id of the key this credential created most recently.
 * Pipe-friendly:
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
    // Same scoping as resolveKeyRef("last"): only keys this credential
    // created, never the newest key on the whole instance.
    const page = await client.listKeys({ limit: 1, mine: 1 });
    if (page.data.length === 0) {
      fail(
        "this API key has not created any keys yet (keys made in the dashboard or with another API key don't count). Run `mantis new \"memo\"` to create one.",
      );
    }
    const key = page.data[0]!;
    emit(
      () => {
        process.stdout.write(safeText(key.id) + "\n");
        process.stderr.write(
          c.dim(`(${safeText(key.memo)} — ${safeText(key.url)})\n`),
        );
      },
      key,
    );
  });
}
