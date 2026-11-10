import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { c, colorOn, mark } from "./out.js";

export type Prompter = {
  ask(question: string): Promise<string>;
  askSecret(question: string): Promise<string>;
  close(): void;
};

export function canPrompt(): boolean {
  return Boolean(process.stdin.isTTY && process.stderr.isTTY);
}

export function createPrompter({ styleAnswer = true } = {}): Prompter {
  let hidden = false;
  const output = Object.assign(new Writable({
    write(chunk, encoding, done) {
      if (!hidden) process.stderr.write(chunk, encoding);
      done();
    },
  }), { columns: process.stderr.columns });
  const onResize = () => {
    output.columns = process.stderr.columns;
    output.emit("resize");
  };
  const rl = createInterface({
    input: process.stdin,
    output,
    terminal: Boolean(process.stderr.isTTY),
  });
  process.stderr.on("resize", onResize);
  rl.once("close", () => process.stderr.off("resize", onResize));
  rl.on("history", (history: string[]) => {
    if (hidden) history.shift();
  });
  return {
    ask: async (question: string) => {
      // What the operator types is the value, so it is the bold part of the
      // line: the prompt ends by turning bold on, and it goes off again once
      // the answer is in.
      const styled = styleAnswer && colorOn();
      const answer = await rl.question(styled ? `${question}\x1b[1m` : question);
      if (styled) process.stderr.write("\x1b[0m");
      return answer.trim();
    },
    askSecret: async (question: string) => {
      // Readline still handles editing and paste in raw mode. Its writes,
      // including redraws after a resize, stay muted for this question.
      const controller = new AbortController();
      const onClose = () => controller.abort();
      rl.once("close", onClose);
      process.stderr.write(question);
      hidden = true;
      try {
        return (await rl.question("", { signal: controller.signal })).trim();
      } finally {
        hidden = false;
        rl.off("close", onClose);
        process.stderr.write("\n");
      }
    },
    close: () => rl.close(),
  };
}

export async function askRequired(
  prompter: Prompter,
  question: string,
): Promise<string> {
  for (;;) {
    const value = await prompter.ask(question);
    if (value) return value;
    process.stderr.write(`${mark("fail")} ${c.red("A value is required.")}\n`);
  }
}

/**
 * Read a secret from stdin, draining fully and stripping one trailing newline.
 * Backs the `--*-stdin` flags so credentials are never passed on argv (where
 * they leak via `ps` / shell history). Mirrors backup.ts's passphrase reader.
 */
export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
}
