import { spawn } from "node:child_process";
import { c, emit } from "../lib/out.js";
import { resolveKeyRef } from "../lib/resolve.js";
import { withClient, type GlobalOpts } from "../lib/runner.js";

export type OpenOpts = GlobalOpts & {
  dashboard?: boolean;
  trigger?: boolean;
};

export async function openCmd(
  idOrUndefined: string | undefined,
  opts: OpenOpts,
): Promise<void> {
  await withClient(opts, async (client) => {
    let target: string;
    let description: string;

    if (!idOrUndefined || opts.dashboard) {
      target = new URL("/keys", client.baseUrl).toString();
      description = "dashboard";
    } else {
      const fullId = await resolveKeyRef(client, idOrUndefined);
      const key = await client.getKey(fullId);
      if (opts.trigger) {
        target = key.url;
        description = `trigger URL for ${key.memo}`;
      } else {
        target = new URL(`/keys/${fullId}`, client.baseUrl).toString();
        description = `dashboard page for ${key.memo}`;
      }
    }

    const launched = launchBrowser(target);
    emit(
      () => {
        if (launched) {
          process.stderr.write(
            `${c.green("✓")} opened ${description}: ${c.cyan(target)}\n`,
          );
        } else {
          process.stderr.write(
            `${c.yellow("⚠")} couldn't launch a browser; visit manually:\n  ${c.cyan(target)}\n`,
          );
        }
      },
      { url: target, launched },
    );
  });
}

function launchBrowser(url: string): boolean {
  const platform = process.platform;
  let cmd: string;
  let args: string[];
  if (platform === "darwin") {
    cmd = "open";
    args = [url];
  } else if (platform === "win32") {
    cmd = "cmd";
    args = ["/c", "start", "", url];
  } else {
    cmd = "xdg-open";
    args = [url];
  }
  try {
    const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
    child.unref();
    return true;
  } catch {
    return false;
  }
}
