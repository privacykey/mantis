import { c, emit } from "../lib/out.js";
import { resolveKeyRef } from "../lib/resolve.js";
import { withClient, type GlobalOpts } from "../lib/runner.js";

export async function disableCmd(
  ids: string[],
  opts: GlobalOpts,
): Promise<void> {
  await withClient(opts, async (client) => {
    let failed = 0;
    for (const ref of ids) {
      try {
        const fullId = await resolveKeyRef(client, ref);
        const t = await client.patchKey(fullId, { disabled: true });
        emit(() => process.stderr.write(`${c.yellow("✓")} disabled ${t.id}\n`), t);
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

export async function enableCmd(
  ids: string[],
  opts: GlobalOpts,
): Promise<void> {
  await withClient(opts, async (client) => {
    let failed = 0;
    for (const ref of ids) {
      try {
        const fullId = await resolveKeyRef(client, ref);
        const t = await client.patchKey(fullId, { disabled: false });
        emit(() => process.stderr.write(`${c.green("✓")} enabled ${t.id}\n`), t);
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
