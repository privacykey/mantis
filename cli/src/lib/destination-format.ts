// How a key's notification destinations are drawn, shared by `show`, `new`
// and `destinations`. Channel and target are written by whoever configured
// the key, so both go through safeText() before they are styled or cut.

import type { Destination } from "./api.js";
import {
  c,
  fitMiddle,
  KV_LABEL_WIDTH,
  mark,
  safeText,
  termWidth,
  truncate,
} from "./out.js";

export type DestinationLine = Pick<
  Destination,
  "channel" | "target" | "last_activation_status" | "last_activation_error"
>;

/**
 * One line per destination: its activation mark, channel and target, with a
 * failure's reason underneath. Shared shape with a hit's delivery lines.
 */
export function destinationLines(destinations: DestinationLine[]): string[] {
  const s = safeText;
  const channelWidth = Math.max(...destinations.map((d) => s(d.channel).length));
  const room = termWidth() - (2 + KV_LABEL_WIDTH + 1) - (2 + channelWidth + 2);
  const lines: string[] = [];
  for (const d of destinations) {
    const state =
      d.last_activation_status === "ok"
        ? "ok"
        : d.last_activation_status === "failed"
          ? "fail"
          : "pending";
    const note = state === "pending" ? `  ${c.dim("not activated yet")}` : "";
    const target = fitMiddle(s(d.target), room - (note ? 19 : 0));
    lines.push(`${mark(state)} ${s(d.channel).padEnd(channelWidth)}  ${target}${note}`);
    if (state === "fail" && d.last_activation_error) {
      const pad = " ".repeat(2 + channelWidth + 2);
      // Cut to the line on a terminal; piped output keeps the whole reason.
      const reason = `activation failed: ${s(d.last_activation_error)}`;
      const avail = termWidth() - (2 + KV_LABEL_WIDTH + 1) - pad.length;
      const fitted = process.stdout.isTTY
        ? truncate(reason, Math.max(20, avail))
        : reason;
      lines.push(`${pad}${c.red(fitted)}`);
    }
  }
  return lines;
}
