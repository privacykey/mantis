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
  withoutRepeat,
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
  const stateOf = (d: DestinationLine) =>
    d.last_activation_status === "ok"
      ? "ok"
      : d.last_activation_status === "failed"
        ? "fail"
        : "pending";
  // Every row ends in a state word, so the glyph never stands alone.
  const wordOf = (state: string) =>
    state === "ok" ? "activated" : state === "pending" ? "not activated yet" : "activation failed";
  const targets = destinations.map((d) => maskSecretUrl(s(d.target)));
  // Results line up in one column when the widest row still fits.
  const targetWidth = Math.max(...targets.map((t) => t.length));
  const wordWidth = Math.max(...destinations.map((d) => wordOf(stateOf(d)).length));
  const aligned = targetWidth + 2 + wordWidth <= room;
  destinations.forEach((d, i) => {
    const state = stateOf(d);
    const word = wordOf(state);
    const target = aligned
      ? targets[i]!.padEnd(targetWidth)
      : fitMiddle(targets[i]!, room - (word.length + 2));
    const wordStyled = state === "fail" ? c.red(word) : word;
    lines.push(`${mark(state)} ${s(d.channel).padEnd(channelWidth)}  ${target}  ${wordStyled}`);
    if (state === "fail" && d.last_activation_error) {
      // The reason wraps under the target on a terminal, whole on a pipe,
      // and does not repeat the target the row above names.
      const pad = " ".repeat(2 + channelWidth + 2);
      const reason = withoutRepeat(s(d.last_activation_error), d.target);
      const avail = termWidth() - (2 + KV_LABEL_WIDTH + 1) - pad.length;
      const wrapped = process.stdout.isTTY ? wrapProse(reason, Math.max(20, avail)) : [reason];
      for (const line of wrapped) lines.push(`${pad}${c.red(line)}`);
    }
  });
  return lines;
}
