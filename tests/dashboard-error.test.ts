import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import DashboardError from "@/app/(app)/error";

function buttonIn(node: ReactNode): ReactElement<{ onClick: () => void; type: string }> | undefined {
  if (!isValidElement<{ children?: ReactNode }>(node)) return undefined;
  if (node.type === "button") {
    return node as ReactElement<{ onClick: () => void; type: string }>;
  }
  let button: ReturnType<typeof buttonIn>;
  Children.forEach(node.props.children, (child) => { button ??= buttonIn(child); });
  return button;
}

afterEach(() => vi.unstubAllGlobals());

describe("dashboard error recovery", () => {
  it("explains an old page after an update and provides a full reload", () => {
    const error = new Error("Server Action private-action-id was not found");
    error.name = "UnrecognizedActionError";
    const html = renderToStaticMarkup(createElement(DashboardError, { error, reset: vi.fn() }));
    expect(html).toContain("Mantis was updated");
    expect(html).toContain("check the current state before trying your action again");
    expect(html).toContain("Unsaved changes may need to be entered again");
    expect(html).toContain("Reload this page");
    expect(html).toContain('role="alert"');
    expect(html).not.toContain("private-action-id");
  });

  it("does not expose exception messages, stacks or digests for other failures", () => {
    const error = Object.assign(new Error("postgres://private-credential@private-host/db"), { digest: "private-digest" });
    error.stack = "private-stack";
    const html = renderToStaticMarkup(createElement(DashboardError, { error, reset: vi.fn() }));
    expect(html).toContain("This page is unavailable");
    expect(html).toContain("check its current status before trying it again");
    expect(html).not.toContain("private-");
    expect(html).not.toContain("postgres://");
  });

  it("does not classify an arbitrary message as an app update", () => {
    const error = new Error("UnrecognizedActionError: injected message");
    const html = renderToStaticMarkup(createElement(DashboardError, { error, reset: vi.fn() }));
    expect(html).toContain("This page is unavailable");
    expect(html).not.toContain("Mantis was updated");
    expect(html).not.toContain("injected message");
  });

  it("does not reload or retry automatically, and reloads the document when activated", () => {
    const reload = vi.fn();
    const reset = vi.fn();
    vi.stubGlobal("window", { location: { reload } });
    const node = DashboardError({ error: new Error("unavailable"), reset });
    renderToStaticMarkup(node);
    expect(reload).not.toHaveBeenCalled();
    expect(reset).not.toHaveBeenCalled();
    const button = buttonIn(node);
    expect(button?.props.type).toBe("button");
    expect(button).toBeDefined();
    button!.props.onClick();
    expect(reload).toHaveBeenCalledOnce();
    expect(reset).not.toHaveBeenCalled();
  });
});
