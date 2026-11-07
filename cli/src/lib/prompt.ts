import { createInterface } from "node:readline/promises";
import { c, colorOn, mark } from "./out.js";

export type Prompter = {
  ask(question: string): Promise<string>;
  close(): void;
};

export function canPrompt(): boolean {
  return Boolean(process.stdin.isTTY && process.stderr.isTTY);
}

export function createPrompter(): Prompter {
  const rl = createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  return {
    ask: async (question: string) => {
      // What the operator types is the value, so it is the bold part of the
      // line: the prompt ends by turning bold on, and it goes off again once
      // the answer is in.
      const styled = colorOn();
      const answer = await rl.question(styled ? `${question}\x1b[1m` : question);
      if (styled) process.stderr.write("\x1b[0m");
      return answer.trim();
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
