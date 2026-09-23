import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/commands/install.js", () => ({
  runInstaller: vi.fn(async () => ({
    filename: "mantis.sh",
    writtenTo: null,
    content: "curl https://mantis.example.com/c/abc123\n",
  })),
}));

import { newCmd } from "../src/commands/new.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("create and install", () => {
  it("prints the generated snippet after creating the key", async () => {
    const output: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output.push(String(chunk));
      return true;
    });
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({
      id: "00000000-0000-4000-8000-000000000001",
      public_id: "abc123",
      url: "https://mantis.example.com/c/abc123",
      memo: "first key",
      destinations: [],
    }), { status: 201, headers: { "content-type": "application/json" } }));

    await newCmd("first key", {
      baseUrl: "https://mantis.example.com",
      key: "test-key",
      install: "shell",
    });

    expect(output.join("")).toContain("curl https://mantis.example.com/c/abc123\n");
  });
});
