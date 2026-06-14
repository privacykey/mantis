import { createInterface } from "node:readline/promises";

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
    ask: async (question: string) => (await rl.question(question)).trim(),
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
    process.stderr.write("Please enter a value.\n");
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
