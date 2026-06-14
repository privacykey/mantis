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

function launchBrowser(rawUrl: string): boolean {
  // Hard-validate before shelling out. spawn() with an args array doesn't
  // invoke a POSIX shell, but on Windows `cmd.exe /c start ...` re-parses
  // its command line through cmd.exe's own parser, where `&`, `|`, `>`,
  // `^` etc. are special — so a URL with those characters can break out
  // of the argv quoting Node applied. The fix:
  //   1) refuse anything that isn't a parseable http/https URL
  //   2) on Windows, use `rundll32.exe url.dll,FileProtocolHandler` so we
  //      never go through cmd.exe at all.
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return false;
  }
  const url = parsed.toString();

  const platform = process.platform;
  let cmd: string;
  let args: string[];
  if (platform === "darwin") {
    cmd = "open";
    args = [url];
  } else if (platform === "win32") {
    cmd = "rundll32.exe";
    args = ["url.dll,FileProtocolHandler", url];
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
