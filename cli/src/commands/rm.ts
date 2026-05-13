import { createInterface } from "node:readline/promises";
import { c, fail } from "../lib/out.js";
import { resolveKeyRef } from "../lib/resolve.js";
import { withClient, type GlobalOpts } from "../lib/runner.js";

export type RmOpts = GlobalOpts & { yes?: boolean };

export async function rmCmd(id: string, opts: RmOpts): Promise<void> {
  await withClient(opts, async (client) => {
    const fullId = await resolveKeyRef(client, id);
    const key = await client.getKey(fullId);

    if (!opts.yes) {
      const rl = createInterface({
        input: process.stdin,
        output: process.stderr,
      });
      try {
        const answer = (
          await rl.question(
            `Delete key ${c.bold(key.id.slice(0, 8))} (${key.memo})? [y/N] `,
          )
        )
          .trim()
          .toLowerCase();
        if (answer !== "y" && answer !== "yes") {
          return fail("cancelled", 0);
        }
      } finally {
        rl.close();
      }
    }

    await client.deleteKey(key.id);
    process.stderr.write(`${c.green("✓")} deleted ${key.id}\n`);
  });
}
