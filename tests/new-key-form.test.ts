import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/app/(app)/keys/new/actions", () => ({ createKeyAction: vi.fn() }));

import { NewKeyForm } from "@/app/(app)/keys/new/form";

describe("new key form", () => {
  it("submits preset response and dedupe even with advanced controls collapsed", () => {
    const html = renderToStaticMarkup(createElement(NewKeyForm));
    expect(html).toContain('name="response_kind" value="gif"');
    expect(html).toContain('name="dedupe_window_seconds" value="300"');
    expect(html).toContain('name="redirect_url" value=""');
    expect(html).toContain('name="html_body" value=""');
    expect(html).toContain('name="json_body" value=""');
    expect(html).toContain('name="memo"');
  });
});
