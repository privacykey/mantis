import { c, emit } from "../lib/out.js";
import { resolveKeyRef } from "../lib/resolve.js";
import { withClient, type GlobalOpts } from "../lib/runner.js";

export async function disableCmd(id: string, opts: GlobalOpts): Promise<void> {
  await withClient(opts, async (client) => {
    const fullId = await resolveKeyRef(client, id);
    const t = await client.patchKey(fullId, { disabled: true });
    emit(
      () => process.stderr.write(`${c.yellow("✓")} disabled ${t.id}\n`),
      t,
    );
  });
}

export async function enableCmd(id: string, opts: GlobalOpts): Promise<void> {
  await withClient(opts, async (client) => {
    const fullId = await resolveKeyRef(client, id);
    const t = await client.patchKey(fullId, { disabled: false });
    emit(
      () => process.stderr.write(`${c.green("✓")} enabled ${t.id}\n`),
      t,
    );
  });
}
