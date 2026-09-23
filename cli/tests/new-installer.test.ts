import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/commands/install.js", () => ({
  runInstaller: vi.fn(async () => ({
    filename: "mantis.sh",
    writtenTo: null,
    content: "curl https://mantis.example.com/c/abc123\n",
  })),
}));

import { newCmd } from "../src/commands/new.js";
import { runInstaller } from "../src/commands/install.js";

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

  it("rejects output modes that would discard a generated snippet before creating a key", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    vi.spyOn(process, "exit").mockImplementation(() => { throw new Error("exited"); });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await expect(newCmd("first key", {
      baseUrl: "https://mantis.example.com",
      key: "test-key",
      install: "shell",
      idOnly: true,
    })).rejects.toThrow("exited");
    expect(fetch).not.toHaveBeenCalled();
    expect(vi.mocked(process.stderr.write).mock.calls.join(" ")).toContain("--install needs --out");
  });

  it("gives a runnable recovery command after an installer fails", async () => {
    vi.mocked(runInstaller).mockRejectedValueOnce(new Error("write failed"));
    const errors: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      errors.push(String(chunk));
      return true;
    });
    vi.spyOn(process, "exit").mockImplementation(() => { throw new Error("exited"); });
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({
      id: "00000000-0000-4000-8000-000000000001",
      public_id: "abc123",
      url: "https://mantis.example.com/c/abc123",
      memo: "first key",
      destinations: [],
    }), { status: 201, headers: { "content-type": "application/json" } }));

    await expect(newCmd("first key", {
      baseUrl: "https://mantis.example.com",
      key: "test-key",
      install: "shell",
    })).rejects.toThrow("exited");
    expect(errors.join(" ")).toContain("mantis install 00000000-0000-4000-8000-000000000001 --type shell");
  });
});
