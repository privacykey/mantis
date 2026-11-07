// Shared building blocks for the interactive wizards on `mantis new` and
// `mantis edge mint`. The two commands ask different questions about
// different state, but they share the same primitive prompts (channel
// pickers, channel-aware URL prompts, yes/no, choice-from-list) and the
// same channel-from-URL inference. Keeping them here means a change to
// inference rules or prompt UX lands once and applies everywhere.

import type { Prompter } from "./prompt.js";
import {
  prose,
  wrapProse,
  proseWidth,
  maskSecretUrl,
  c,
  colorOn,
  kv,
  type KvRow,
  mark,
  visibleLength,
} from "./out.js";

export const URL_RE = /^https?:\/\/.+/;

// ---------------------------------------------------------------------------
// Channel inference + labelling
// ---------------------------------------------------------------------------

/**
 * Webhook host → notification channel. Returns null when the host doesn't
 * match a known service. Both commands use this to either auto-promote a
 * default channel or warn about a channel/URL mismatch.
 */
export function inferChannelFromWebhook(webhook: string): string | null {
  let host: string;
  try {
    host = new URL(webhook).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (host === "discord.com" || host.endsWith(".discord.com")) return "discord";
  if (host === "hooks.slack.com" || host.endsWith(".hooks.slack.com")) {
    return "slack";
  }
  if (
    host.endsWith(".webhook.office.com") ||
    host.endsWith(".logic.azure.com")
  ) {
    return "teams";
  }
  return null;
}

/** Label for the URL prompt, tailored to the chosen channel. */
export function webhookPromptLabel(channel: string): string {
  switch (channel) {
    case "discord":
      return "Discord webhook URL";
    case "slack":
      return "Slack webhook URL";
    case "teams":
      return "Teams workflow webhook URL";
    case "email":
      return "Email address";
    case "webhook":
    default:
      return "Webhook URL";
  }
}

// ---------------------------------------------------------------------------
// Primitive prompts
// ---------------------------------------------------------------------------

/** `Label [default]: ` with the default dimmed, so the question leads. */
function promptText(label: string, def?: string, sep = ":"): string {
  return def ? `${label} ${c.dim(`[${def}]`)}${sep} ` : `${label}${sep} `;
}

/**
 * After Enter on an empty line, write the accepted default where the answer
 * would be, so the transcript shows what was chosen. Terminal only, and only
 * when the prompt fits on one line (the line is redrawn in place).
 */
function echoAccepted(prompt: string, value: string): void {
  if (!value || !colorOn() || !process.stderr.isTTY) return;
  if (process.env.TERM === "dumb") return;
  const cols = process.stderr.columns ?? 80;
  if (visibleLength(prompt) + value.length >= cols) return;
  process.stderr.write(`\x1b[1A\r\x1b[2K${prompt}${c.dim(value)}\n`);
}

/** Re-prompt loop for a value that must start with https:// (or http://). */
export async function askUrl(
  p: Prompter,
  label: string,
  opts: { default?: string; allowEmpty?: boolean } = {},
): Promise<string | undefined> {
  const indent = /^\s*/.exec(label)![0];
  for (;;) {
    const def = opts.default ?? "";
    const prompt = promptText(label, def);
    const ans = await p.ask(prompt);
    if (!ans) echoAccepted(prompt, def);
    const v = ans || def;
    if (!v) {
      if (opts.allowEmpty) return undefined;
      warn("A value is required.", indent);
      continue;
    }
    if (URL_RE.test(v)) {
      if (ans) echoMasked(prompt, maskSecretUrl(v));
      return v;
    }
    warn("The URL must start with https://", indent);
  }
}

/**
 * Redraw an accepted answer in a safer form (a masked webhook), at default
 * weight. Terminal only, and only when the line fits.
 */
function echoMasked(prompt: string, shown: string): void {
  if (!colorOn() || !process.stderr.isTTY) return;
  if (process.env.TERM === "dumb") return;
  const cols = process.stderr.columns ?? 80;
  if (visibleLength(prompt) + shown.length >= cols) return;
  process.stderr.write(`\x1b[1A\r\x1b[2K${prompt}${shown}\n`);
}

/** Yes/no with a typed default. `default: true` shows `[Y/n]`. */
export async function askYesNo(
  p: Prompter,
  label: string,
  defaultYes: boolean,
): Promise<boolean> {
  const prompt = promptText(label, defaultYes ? "Y/n" : "y/N", "");
  const ans = (await p.ask(prompt)).toLowerCase();
  if (!ans) {
    echoAccepted(prompt, defaultYes ? "y" : "n");
    return defaultYes;
  }
  if (ans === "y" || ans === "yes") return true;
  if (ans === "n" || ans === "no") return false;
  // Anything else → treat as the default (matches typical CLI conventions).
  return defaultYes;
}

// A list of choices is spelled out the first time it is asked for; a repeat
// of the same question (a second destination) only needs the default.
const choicesShown = new Set<string>();

/** Choice from a fixed list. Re-prompts on invalid input. */
export async function askChoice<T extends string>(
  p: Prompter,
  label: string,
  choices: readonly T[],
  def: T,
): Promise<T> {
  const indent = /^\s*/.exec(label)![0];
  for (;;) {
    const first = !choicesShown.has(label);
    choicesShown.add(label);
    // Shown with hyphens (`home-assistant`); typed either way.
    const shown = (x: string) => x.replace(/_/g, "-");
    const prompt = first
      ? `${label} ${c.dim(`(${choices.map(shown).join(", ")}) [${shown(def)}]`)}: `
      : promptText(label, shown(def));
    const ans = (await p.ask(prompt)).toLowerCase().replace(/-/g, "_");
    if (!ans) echoAccepted(prompt, shown(def));
    const v = (ans || def) as T;
    if ((choices as readonly string[]).includes(v)) return v;
    choicesShown.delete(label);
    warn(`Pick one of: ${choices.map(shown).join(", ")}.`, indent);
  }
}

/**
 * Free-text prompt with optional default. Blank input returns default (or
 * empty). `blank` names what an empty answer means when there is no default
 * value to show (`never`, `stdout`).
 */
export async function askText(
  p: Prompter,
  label: string,
  opts: { default?: string; blank?: string } = {},
): Promise<string> {
  const def = opts.default ?? "";
  const prompt = promptText(label, def || opts.blank);
  const ans = await p.ask(prompt);
  if (!ans) echoAccepted(prompt, def || opts.blank || "");
  return ans || def;
}

// ---------------------------------------------------------------------------
// Summary table + confirm/edit loop
// ---------------------------------------------------------------------------

export type SummaryRow = KvRow;

/** Print "Summary" followed by the shared label and value block. */
export function printSummary(rows: readonly SummaryRow[]): void {
  process.stderr.write(`\n${c.bold("Summary")}\n${kv([...rows])}\n`);
}

/**
 * Confirm/edit loop. The caller supplies a function to print the current
 * summary, the list of editable field names, and a per-field edit handler.
 * Returns when the user confirms (`y`/blank/`yes`) or aborts (`n`/`no`).
 */
export async function confirmLoop(
  p: Prompter,
  printCurrent: () => void,
  fields: readonly string[],
  edit: (field: string) => Promise<void>,
): Promise<void> {
  for (;;) {
    printCurrent();
    const ans = (
      await p.ask(`${c.bold("Proceed?")} ${c.dim("[Y/n/edit]")} `)
    ).toLowerCase();
    if (ans === "" || ans === "y" || ans === "yes") return;
    if (ans === "n" || ans === "no") {
      process.stderr.write(`${mark("none")} Stopped. Nothing was created.\n`);
      process.exit(0);
    }
    if (ans === "edit" || ans === "e") {
      const which = (
        await p.ask(
          `Which field? ${c.dim(`(${fields.join(", ")}; blank to cancel)`)}: `,
        )
      ).toLowerCase();
      if (!which) continue;
      if (!fields.includes(which)) {
        warn(`Unknown field. Pick one of: ${fields.join(", ")}.`);
        continue;
      }
      await edit(which);
      continue;
    }
    warn("Answer y, n, or edit.");
  }
}

// ---------------------------------------------------------------------------
// Lines the wizards print between prompts
// ---------------------------------------------------------------------------

/** A rejected answer: red, with the failure mark, at the prompt's indent. */
export function warn(msg: string, indent = ""): void {
  process.stderr.write(`${indent}${mark("fail")} ${c.red(msg)}\n`);
}

/** Something the wizard decided on the operator's behalf: dim, wrapped. */
export function note(msg: string, indent = ""): void {
  const width = proseWidth(process.stderr) - indent.length;
  for (const line of wrapProse(msg, width)) {
    process.stderr.write(`${indent}${prose(line, c.dim)}\n`);
  }
}
