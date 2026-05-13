import type { MonitorMode } from "../lib/api.js";
import { c, emit } from "../lib/out.js";
import { resolveKeyRef } from "../lib/resolve.js";
import { withClient, type GlobalOpts } from "../lib/runner.js";

const MODES: readonly MonitorMode[] = ["off", "latch", "window"];

export type MonitorOpts = GlobalOpts & {
  mode?: string;
  window?: string;
};

export async function monitorCmd(id: string, opts: MonitorOpts): Promise<void> {
  if (!opts.mode || !(MODES as readonly string[]).includes(opts.mode)) {
    throw new Error(`--mode is required. Allowed: ${MODES.join(", ")}`);
  }
  const mode = opts.mode as MonitorMode;
  const windowSeconds = opts.window ? Number(opts.window) : undefined;
  if (
    windowSeconds !== undefined &&
    (!Number.isFinite(windowSeconds) ||
      windowSeconds < 30 ||
      windowSeconds > 86_400)
  ) {
    throw new Error("--window must be 30–86400 seconds");
  }

  await withClient(opts, async (client) => {
    const fullId = await resolveKeyRef(client, id);
    const key = await client.setMonitor(fullId, {
      mode,
      window_seconds: windowSeconds,
    });

    let currentState: "ok" | "tripped" | "off" = "off";
    let trippedAt: string | undefined;
    if (key.monitor_mode !== "off") {
      try {
        const s = await client.fetchStatus(key.public_id);
        currentState = s.status;
        trippedAt = s.tripped_at;
      } catch {
        currentState = "off";
      }
    }

    emit(
      () => {
        const w = process.stdout.write.bind(process.stdout);
        w(
          `${c.green("✓")} monitor set: ${c.bold(key.monitor_mode)}` +
            (key.monitor_mode === "window"
              ? ` (${key.monitor_window_seconds}s)`
              : "") +
            "\n",
        );
        if (key.monitor_status_url) {
          w(`  ${c.dim("status URL:")} ${c.cyan(key.monitor_status_url)}\n`);
          w(
            `  ${c.dim("current:   ")} ${
              currentState === "tripped"
                ? c.red("tripped") + (trippedAt ? c.dim(` @ ${trippedAt}`) : "")
                : currentState === "ok"
                  ? c.green("ok")
                  : c.dim("off")
            }\n`,
          );
        }
      },
      {
        ...key,
        monitor_state: currentState,
        monitor_tripped_at: trippedAt ?? null,
      },
    );
  });
}
