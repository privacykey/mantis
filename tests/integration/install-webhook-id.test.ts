import { describe, it, expect, vi } from "vitest";

// The Home Assistant receiver's webhook id is its only credential. The server
// derives it from a secret, so it is stable across renders (the dashboard
// fetches the steps as JSON and the YAML as a separate download) and cannot
// be worked out from the key id that lower-trust parties see.

vi.mock("@/lib/log", () => ({
  log: { info() {}, warn() {}, error() {}, debug() {}, fatal() {}, trace() {} },
}));

import { GET as install } from "@/app/api/keys/[id]/install/route";
import { buildJsonRequest, ctxParams, seedApiKey, seedCanaryKey } from "./_harness";

describe("homeassistant-receiver installer", () => {
  it("embeds one stable, key-independent webhook id in every render", async () => {
    const owner = await seedApiKey();
    const key = await seedCanaryKey(owner.row.id);
    const other = await seedCanaryKey(owner.row.id);
    const fetchInstaller = (id: string, format?: "json") =>
      install(
        buildJsonRequest(
          `/api/keys/${id}/install?type=homeassistant-receiver${format ? "&format=json" : ""}`,
          { bearer: owner.plaintext },
        ),
        ctxParams({ id }),
      );

    const json = (await (await fetchInstaller(key.id, "json")).json()) as {
      content: string;
      install: string[];
      webhookId: string;
    };
    const raw = await (await fetchInstaller(key.id)).text();

    expect(json.webhookId).toMatch(/^mantis-[0-9a-f]{48}$/);
    expect(raw).toBe(json.content);
    expect(raw).toContain(`webhook_id: "${json.webhookId}"`);
    expect(json.install.join("\n")).toContain(`/api/webhook/${json.webhookId}`);

    // Nothing of the key id is in the credential.
    expect(json.webhookId).not.toContain(key.id.slice(0, 8));
    expect(json.webhookId).not.toContain(key.id.replace(/-/g, "").slice(0, 8));

    const otherJson = (await (await fetchInstaller(other.id, "json")).json()) as {
      webhookId: string;
    };
    expect(otherJson.webhookId).not.toBe(json.webhookId);
  });
});
