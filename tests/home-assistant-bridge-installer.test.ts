import { describe, expect, it } from "vitest";
import { buildInstaller } from "@mantis/core/installers";

// The bridge's "automation triggered" example forwards every Home Assistant
// automation run to Mantis. Its own runs, and the runs of the Mantis receiver
// (which Mantis itself triggers when a hit is delivered), are automation runs
// too — without an exclusion each POST can cause the next one.

const input = {
  url: "https://mantis.example.com/c/abc123def456",
  keyId: "00000000-0000-0000-0000-000000000001",
  memo: "front door",
};

/** The YAML of one automation entry, from its alias to the next entry. */
function automation(content: string, alias: string): string {
  const start = content.indexOf(`  - alias: ${alias}`);
  expect(start, `no automation aliased ${alias}`).toBeGreaterThan(0);
  const next = content.indexOf("\n  - alias:", start + 1);
  return content.slice(start, next < 0 ? undefined : next);
}

/**
 * Evaluate the bridge's condition the way the template reads: true when the
 * triggering automation is neither this one nor a Mantis one.
 */
function bridges(event: { name?: string | null; entity_id?: string | null }, self: string): boolean {
  const name = String(event.name || "").toLowerCase();
  const entity = String(event.entity_id || "");
  return (
    event.entity_id !== self &&
    !name.startsWith("mantis") &&
    !entity.startsWith("automation.mantis_")
  );
}

describe("homeassistant bridge installer", () => {
  const out = buildInstaller("homeassistant", input);
  const bridge = automation(out.content, '"Mantis - automation triggered"');

  it("conditions the automation_triggered example on who triggered it", () => {
    const keys = [...bridge.matchAll(/^ {4}([a-z_]+):/gm)].map((m) => m[1]);
    expect(keys).toEqual(["mode", "max", "triggers", "conditions", "actions"]);

    const template = /value_template: >-\n((?: {10}.*\n)+)/.exec(bridge);
    expect(template, bridge).toBeTruthy();
    // Folded scalar: the lines join with single spaces into one expression.
    const expr = template![1]!.split("\n").map((l) => l.trim()).filter(Boolean).join(" ");
    expect(expr).toBe(
      "{{ trigger.event.data.entity_id != this.entity_id " +
        "and not (trigger.event.data.name | default('', true) | string | lower).startswith('mantis') " +
        "and not (trigger.event.data.entity_id | default('', true) | string).startswith('automation.mantis_') }}",
    );
    // Same indentation on every line, so YAML folds them instead of keeping
    // the line breaks of a more-indented block.
    const indents = new Set(template![1]!.split("\n").filter(Boolean).map((l) => /^ */.exec(l)![0].length));
    expect([...indents]).toEqual([10]);
  });

  it("the exclusion covers itself, the examples and the Mantis receiver", () => {
    const self = "automation.mantis_automation_triggered";
    // Every alias this file generates is excluded…
    const aliases = [...out.content.matchAll(/^ {2}- alias: "(.*)"$/gm)].map((m) => m[1]!);
    expect(aliases).toHaveLength(4);
    for (const name of aliases) {
      expect(bridges({ name, entity_id: "automation.whatever" }, self), name).toBe(false);
    }
    // …as is the receiver that Mantis calls, whatever the key's memo…
    const receiver = buildInstaller("homeassistant-receiver", input);
    const receiverAlias = JSON.parse(/^ {2}- alias: (".*")$/m.exec(receiver.content)![1]!) as string;
    expect(bridges({ name: receiverAlias, entity_id: "automation.x" }, self)).toBe(false);
    // …and this automation even after a rename, by entity id.
    expect(bridges({ name: "Renamed", entity_id: self }, self)).toBe(false);
    expect(bridges({ name: "Renamed", entity_id: "automation.mantis_hit_front_door" }, self)).toBe(false);
    // Everything else is still bridged.
    expect(bridges({ name: "Porch light at dusk", entity_id: "automation.porch_light" }, self)).toBe(true);
    expect(bridges({ name: null, entity_id: "automation.unnamed" }, self)).toBe(true);
  });

  it("bounds the queue", () => {
    expect(bridge).toMatch(/^ {4}mode: queued\n {4}max: 10$/m);
  });

  it("leaves the other examples as they were", () => {
    for (const alias of [
      '"Mantis - front door opened"',
      '"Mantis - unexpected device online"',
      '"Mantis - person at front door"',
    ]) {
      const a = automation(out.content, alias);
      expect(a).toContain("    mode: single\n");
      expect(a).toContain("      - action: rest_command.mantis_iot_event\n");
      expect(a).not.toContain("this.entity_id");
    }
  });
});
