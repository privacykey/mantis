import { c, emit } from "../lib/out.js";
import { resolveKeyRef } from "../lib/resolve.js";
import { withClient, type GlobalOpts } from "../lib/runner.js";

export async function resetCmd(id: string, opts: GlobalOpts): Promise<void> {
  await withClient(opts, async (client) => {
    const fullId = await resolveKeyRef(client, id);
    const key = await client.resetMonitor(fullId);
    emit(
      () => {
        const w = process.stdout.write.bind(process.stdout);
        const state = key.monitor_state ?? "off";
        w(`${c.green("✓")} monitor reset\n`);
        w(
          `  ${c.dim("current:")} ${
            state === "tripped"
              ? c.red("still tripped")
              : state === "ok"
                ? c.green("ok")
                : c.dim("off")
          }\n`,
        );
      },
      key,
    );
  });
}
