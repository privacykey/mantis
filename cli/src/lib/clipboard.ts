import { spawn } from "node:child_process";

type ClipboardCommand = {
  cmd: string;
  args: string[];
};

export async function copyToClipboard(text: string): Promise<boolean> {
  for (const candidate of candidates()) {
    if (await tryCopy(candidate, text)) return true;
  }
  return false;
}

function candidates(): ClipboardCommand[] {
  if (process.platform === "darwin") {
    return [{ cmd: "pbcopy", args: [] }];
  }
  if (process.platform === "win32") {
    return [
      {
        cmd: "powershell.exe",
        args: ["-NoProfile", "-Command", "Set-Clipboard"],
      },
    ];
  }
  return [
    { cmd: "wl-copy", args: [] },
    { cmd: "xclip", args: ["-selection", "clipboard"] },
    { cmd: "xsel", args: ["--clipboard", "--input"] },
  ];
}

async function tryCopy(
  candidate: ClipboardCommand,
  text: string,
): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(candidate.cmd, candidate.args, {
      stdio: ["pipe", "ignore", "ignore"],
    });
    const timer = setTimeout(() => {
      child.kill();
      resolve(false);
    }, 2000);

    child.on("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
    child.stdin.on("error", () => {
      /* close/error handlers resolve */
    });
    child.stdin.end(text);
  });
}
