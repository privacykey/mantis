import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bulkCreateCmd } from "../src/commands/bulk-create.js";

describe("bulkCreateCmd", () => {
  beforeEach(() => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    process.exitCode = undefined;
  });

  it("creates one key per CSV row and writes generated URLs", async () => {
    const requests: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", async (_url: URL, init: RequestInit) => {
      const input = JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>;
      requests.push(input);
      const publicId = `pub${String(requests.length).padStart(3, "0")}`;
      const id = `00000000-0000-4000-8000-${String(requests.length).padStart(12, "0")}`;
      return new Response(
        JSON.stringify({
          id,
          public_id: publicId,
          url: `https://mantis.example.com/c/${publicId}`,
          kind: "key",
          memo: input.memo,
          response_kind: input.response_kind ?? "gif",
          response_payload: input.response_payload ?? null,
          destinations: [],
          dedupe_window_seconds: 60,
          monitor_mode: "off",
          monitor_window_seconds: 300,
          monitor_reset_at: null,
          monitor_status_url: null,
          created_at: "2026-05-13T00:00:00.000Z",
          disabled_at: null,
          expires_at: null,
          disabled: false,
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    });

    const dir = await mkdtemp(join(tmpdir(), "mantis-bulk-test-"));
    const input = join(dir, "in.csv");
    const output = join(dir, "out.csv");
    await writeFile(
      input,
      [
        "area,device,notify_webhook",
        "Front door,Person detected,https://hooks.example.com/front",
        "Garage,Unexpected device,https://hooks.example.com/garage",
      ].join("\n") + "\n",
    );

    await bulkCreateCmd({
      baseUrl: "https://mantis.example.com",
      key: "test-key",
      csv: input,
      out: output,
      memoTemplate: "{{area}} - {{device}}",
    });

    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({
      memo: "Front door - Person detected",
      destinations: [
        { channel: "webhook", target: "https://hooks.example.com/front" },
      ],
    });
    const csv = await readFile(output, "utf8");
    expect(csv).toContain("mantis_url");
    expect(csv).toContain("https://mantis.example.com/c/pub001");
    expect(csv).toContain("https://mantis.example.com/c/pub002");
  });

  it("dry-runs validation errors into mantis_error", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mantis-bulk-test-"));
    const input = join(dir, "in.csv");
    const output = join(dir, "out.csv");
    await writeFile(input, "room,device\n,Sensor\n");

    await bulkCreateCmd({
      csv: input,
      out: output,
      dryRun: true,
    });

    const csv = await readFile(output, "utf8");
    expect(process.exitCode).toBe(1);
    expect(csv).toContain("mantis_error");
    expect(csv).toContain("row 2: add a memo, area, or name column");
  });
});
