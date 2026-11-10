import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { setColorMode } from "../src/lib/out.js";
import { createPrompter } from "../src/lib/prompt.js";
import { askUrl } from "../src/lib/wizard.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  setColorMode("auto");
});

it.each(["xterm-256color", "dumb"])("accepts a pasted webhook without echo under TERM=%s", async (term) => {
  vi.stubEnv("TERM", term);
  setColorMode("never");
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode: vi.fn() });
  const output = Object.assign(new PassThrough(), { isTTY: true, columns: 80 });
  const transcript: string[] = [];
  output.on("data", (chunk) => transcript.push(String(chunk)));
  vi.spyOn(process, "stdin", "get").mockReturnValue(input as unknown as typeof process.stdin);
  vi.spyOn(process, "stderr", "get").mockReturnValue(output as unknown as typeof process.stderr);

  const prompt = createPrompter();
  try {
    const target = "https://fixture.invalid/hook?token=" + "fake".repeat(30);
    const answer = askUrl(prompt, "Webhook URL");
    input.write(target);
    output.columns = 20;
    output.emit("resize");
    input.write("\r");
    expect(await answer).toBe(target);

    // A later ordinary question cannot recall the webhook via history.
    const next = prompt.ask("Memo: ");
    input.write("\x1b[A\r");
    expect(await next).toBe("");
    const rendered = transcript.join("");
    expect(rendered).toContain("https://fixture.invalid/");
    expect(rendered).not.toContain("token=");
    expect(rendered).not.toContain("fake");
  } finally {
    prompt.close();
  }
  expect(output.listenerCount("resize")).toBe(0);
});
