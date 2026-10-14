import { describe, expect, it, vi } from "vitest";

// POST /api/keys pings each new destination synchronously, and the refusal
// text used to name what this server's resolver answered ("db resolves to
// private address 172.18.0.2", or Node's "getaddrinfo ENOTFOUND <host>" for a
// name that does not exist): an oracle over the server's internal DNS, open
// to the enrollment-scoped key embedded on every managed machine. A caller
// now gets one constant message, in the response and in the persisted
// last_activation_error; an enrollment key cannot probe at all (destinations
// outside the operator's allowlist are refused before anything is resolved)
// and never sees transport error text.

vi.mock("@/lib/log", () => ({
  log: { info() {}, warn() {}, error() {}, debug() {}, fatal() {}, trace() {} },
}));

import { POST as createKey } from "@/app/api/keys/route";
import { db } from "@/db/client";
import { notificationDestinations } from "@/db/schema";
import { SELF_DESTINATION } from "@/lib/notify/self-target";
import { REFUSED_DESTINATION } from "@/lib/ssrf";
import { buildJsonRequest, seedApiKey } from "./_harness";

type Created = {
  destinations: Array<{
    target: string;
    activation: { ok: boolean; error?: string };
    last_activation_error: string | null;
  }>;
};

describe("activation refusals do not expose the server's resolver", () => {
  // Refused before any connection: ALLOW_PRIVATE_WEBHOOKS is unset.
  const targets = [
    { channel: "webhook", target: "http://localhost:9/hook" }, // a NAME the server resolves to loopback
    { channel: "webhook", target: "http://127.0.0.1:9/hook" }, // private IPv4 literal
    { channel: "home_assistant", target: "http://[::1]:9/api/webhook/probe" }, // bracketed IPv6 literal
  ];
  const create = (bearer: string) =>
    createKey(
      buildJsonRequest("/api/keys", {
        method: "POST",
        bearer,
        body: { memo: "probe", destinations: targets },
      }),
    );

  it("answers private-target probes with one constant error", async () => {
    const full = await seedApiKey();
    const res = await create(full.plaintext);
    expect(res.status).toBe(201);
    const body = (await res.json()) as Created;

    expect(body.destinations).toHaveLength(3);
    for (const d of body.destinations) {
      expect(d.activation).toEqual({ ok: false, error: REFUSED_DESTINATION });
      expect(d.last_activation_error).toBe(REFUSED_DESTINATION);
    }
    // Nothing about the resolution anywhere else in the response either.
    expect(JSON.stringify(body)).not.toMatch(/resolves to|private address|did not resolve|ENOTFOUND/);

    const stored = await db.select().from(notificationDestinations);
    expect(stored.map((d) => d.lastActivationError)).toEqual(Array(3).fill(REFUSED_DESTINATION));
  });

  it("gives an enrollment key no probe at all, and no error text for approved targets", async () => {
    const enroll = await seedApiKey({ scope: "enroll" });

    // Not on the operator's allowlist: refused before anything is resolved.
    const refused = await create(enroll.plaintext);
    expect(refused.status).toBe(403);
    expect(await db.select().from(notificationDestinations)).toEqual([]);

    // Approved targets are pinged, but the enroll response carries only ok/not.
    process.env.MANTIS_ENROLL_DESTINATIONS = targets
      .map((t) => `${t.channel}:${t.target}`)
      .join(" ");
    try {
      const res = await create(enroll.plaintext);
      expect(res.status).toBe(201);
      const body = (await res.json()) as Created;
      expect(body.destinations).toHaveLength(3);
      for (const d of body.destinations) {
        expect(d.activation).toEqual({ ok: false });
        expect(d.last_activation_error).toBeNull();
      }
      expect(JSON.stringify(body)).not.toContain(REFUSED_DESTINATION);
    } finally {
      delete process.env.MANTIS_ENROLL_DESTINATIONS;
    }
  });

  it("refuses a destination that points back at this instance when the key is created", async () => {
    const enroll = await seedApiKey({ scope: "enroll" });
    const res = await createKey(
      buildJsonRequest("/api/keys", {
        method: "POST",
        bearer: enroll.plaintext,
        body: {
          memo: "re-entry",
          dedupe_window_seconds: 0,
          // PUBLIC_BASE_URL in this suite: a delivery here would be a new hit.
          destinations: [{ channel: "webhook", target: "http://localhost:3000/c/AbCdEf1234?n=1" }],
        },
      }),
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(await res.text()).toContain(SELF_DESTINATION);
    expect(await db.select().from(notificationDestinations)).toEqual([]);
  });
});
