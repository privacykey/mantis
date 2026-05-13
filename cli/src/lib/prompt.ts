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
