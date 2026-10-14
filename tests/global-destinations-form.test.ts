import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/app/(app)/settings/notifications/actions", () => ({
  saveGlobalDestinationsAction: vi.fn(),
  revealGlobalSigningSecretAction: vi.fn(),
  rotateGlobalSigningSecretAction: vi.fn(),
}));

import {
  GlobalDestinationsForm,
  type ExistingDestination,
} from "@/app/(app)/settings/notifications/form";

const webhook: ExistingDestination = {
  id: "00000000-0000-4000-8000-000000000001",
  channel: "webhook",
  target: "https://soc.example/hook",
  signingSecretFingerprint: "AbCd…WxYz",
  lastActivationStatus: "ok",
  lastActivationError: null,
};
const slack: ExistingDestination = {
  id: "00000000-0000-4000-8000-000000000002",
  channel: "slack",
  target: "https://hooks.slack.com/services/T0/B0/x",
  signingSecretFingerprint: null,
  lastActivationStatus: "ok",
  lastActivationError: null,
};

function render(existing: ExistingDestination[]): string {
  return renderToStaticMarkup(createElement(GlobalDestinationsForm, { existing }));
}

// Global webhook deliveries are signed, so the settings page has to let the
// admin get at the secret: fingerprint plus reveal / rotate, as on a key page.
describe("global destinations form", () => {
  it("shows a saved webhook's signing-secret fingerprint with reveal and rotate controls", () => {
    const html = render([webhook]);
    expect(html).toContain("signing secret");
    expect(html).toContain("AbCd…WxYz");
    expect(html).toMatch(/<button type="button"[^>]*>reveal<\/button>/);
    expect(html).toMatch(/<button type="button"[^>]*>rotate<\/button>/);
  });

  it("offers no secret controls for channels that are not signed", () => {
    const html = render([slack]);
    expect(html).not.toContain("signing secret");
    expect(html).not.toContain(">reveal<");
  });

  it("keeps the controls out of the form submission", () => {
    // Every control inside the <form> must be type=button, or clicking
    // "reveal" would save the destinations instead.
    const html = render([webhook, slack]);
    const buttons = html.match(/<button [^>]*>/g) ?? [];
    expect(buttons.filter((b) => b.includes('type="submit"'))).toHaveLength(1);
    expect(buttons.filter((b) => !b.includes("type="))).toEqual([]);
  });
});
