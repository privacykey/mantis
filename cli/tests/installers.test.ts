import { describe, expect, it } from "vitest";
import {
  applySshOnlyGuard,
  buildInstaller,
  type InstallerInput,
} from "@mantis/core/installers";

const INPUT: InstallerInput = {
  url: "https://mantis.example.com/c/abc12345",
  keyId: "abc12345-1111-2222-3333-444444444444",
  memo: "test key",
};

/** Locate the `(curl … ) 2>/dev/null` block the same way applySshOnlyGuard does. */
function curlBlock(lines: string[]): { start: number; end: number } {
  const start = lines.findIndex((l) => l.trim().startsWith("(curl "));
  const end = lines.findIndex(
    (l, i) => i >= start && l.includes(") 2>/dev/null"),
  );
  return { start, end };
}

const CAPTURE = "_mantis_tty=$(tty 2>/dev/null) || _mantis_tty=";
const TTY_HEADER = '-H "X-Mantis-TTY: ${_mantis_tty:-}"';

describe.each(["shell", "shell-sudo"] as const)(
  "%s installer tty capture",
  (type) => {
    it("reads the tty in the foreground, not inside the backgrounded curl", () => {
      const { content } = buildInstaller(type, INPUT);
      const lines = content.split("\n");
      const capture = lines.findIndex((l) => l.trim() === CAPTURE);
      const { start, end } = curlBlock(lines);
      const unsetLine = lines.findIndex((l) => l.trim() === "unset _mantis_tty");

      expect(capture).toBeGreaterThanOrEqual(0);
      expect(start).toBeGreaterThan(capture);
      expect(end).toBeGreaterThan(start);
      expect(unsetLine).toBeGreaterThan(end);
      expect(content).toContain(TTY_HEADER);

      // Regression guard: $(tty) inside the backgrounded subshell always
      // reports "not a tty" because the async child's stdin is /dev/null.
      const block = lines.slice(start, end + 1).join("\n");
      expect(block).not.toContain("$(tty");
    });

    it("keeps tty capture outside the --ssh-only guard", () => {
      const { content } = buildInstaller(type, INPUT);
      const lines = applySshOnlyGuard(content).split("\n");
      const capture = lines.findIndex((l) => l.trim() === CAPTURE);
      const ifLine = lines.findIndex((l) =>
        l.includes('if [[ -n "$SSH_CONNECTION" ]]'),
      );
      const fiLine = lines.findIndex((l) => l.trim() === "fi");
      const unsetLine = lines.findIndex((l) => l.trim() === "unset _mantis_tty");
      const { start, end } = curlBlock(lines);

      // capture → if → (curl … ) → fi → unset
      expect(capture).toBeGreaterThanOrEqual(0);
      expect(ifLine).toBeGreaterThan(capture);
      expect(start).toBeGreaterThan(ifLine);
      expect(fiLine).toBeGreaterThan(end);
      expect(unsetLine).toBeGreaterThan(fiLine);
    });
  },
);
