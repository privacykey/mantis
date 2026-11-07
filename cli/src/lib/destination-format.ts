// How a key's notification destinations are drawn, shared by `show`, `new`
// and `destinations`. Channel and target are written by whoever configured
// the key, so both go through safeText() before they are styled or cut.

import type { Destination } from "./api.js";
import {
  c,
  fitMiddle,
  KV_LABEL_WIDTH,
  mark,
  maskSecretUrl,
  safeText,
  termWidth,
  wrapProse,
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
    // Every row ends in a state word, so the glyph never stands alone.
    const word =
      state === "ok" ? "activated" : state === "pending" ? "not activated yet" : "activation failed";
    const target = fitMiddle(maskSecretUrl(s(d.target)), room - (word.length + 2));
    const wordStyled = state === "fail" ? c.red(word) : c.dim(word);
    lines.push(`${mark(state)} ${s(d.channel).padEnd(channelWidth)}  ${target}  ${wordStyled}`);
    if (state === "fail" && d.last_activation_error) {
      // The reason wraps under the target on a terminal, whole on a pipe.
      const pad = " ".repeat(2 + channelWidth + 2);
      const reason = s(d.last_activation_error);
      const avail = termWidth() - (2 + KV_LABEL_WIDTH + 1) - pad.length;
      const wrapped = process.stdout.isTTY ? wrapProse(reason, Math.max(20, avail)) : [reason];
      for (const line of wrapped) lines.push(`${pad}${c.red(line)}`);
    }
  }
  return lines;
}
