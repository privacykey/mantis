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
  c,
  colorOn,
  kv,
  type KvRow,
  mark,
  visibleLength,
  webhookPreview,
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

// On a terminal wide enough, the wizard reads as a form: questions on the
// left, defaults in a dim column of their own, and every answer starting in
// one column (44), so the answers can be read straight down. Narrower than 70
// columns, or for a question too long for its column, it falls back to the
// inline `Question [default]: answer`.
const QUESTION_WIDTH = 33;
const DEFAULT_WIDTH = 11;
const ANSWER_COLUMN = QUESTION_WIDTH + DEFAULT_WIDTH;
const MIN_FORM_COLUMNS = 70;

function inForm(label: string): boolean {
  return (
    Boolean(process.stderr.isTTY) &&
    (process.stderr.columns ?? 80) >= MIN_FORM_COLUMNS &&
    label.length <= QUESTION_WIDTH - 2
  );
}

/** Where a line that belongs to the answer (the choices, a rejection) starts. */
function answerIndent(label: string): string | undefined {
  return inForm(label) ? " ".repeat(ANSWER_COLUMN) : undefined;
}

/** The question, then its default dimmed, so the question leads. */
function promptText(label: string, def?: string, sep = ":"): string {
  if (inForm(label)) {
    const shown = def ? `[${def}]` : "";
    const gap = " ".repeat(Math.max(1, DEFAULT_WIDTH - shown.length));
    return `${label.padEnd(QUESTION_WIDTH)}${def ? `${c.dim(shown)}${gap}` : " ".repeat(DEFAULT_WIDTH)}`;
  }
  return def ? `${label} ${c.dim(`[${def}]`)}${sep} ` : `${label}${sep} `;
}

/**
 * After Enter on an empty line, write the accepted default where the answer
 * would be, in bold like a typed answer, so the transcript shows what was
 * chosen and every answer reads the same.
 */
function echoAccepted(prompt: string, value: string): void {
  if (!value || !colorOn() || !process.stderr.isTTY || process.env.TERM === "dumb") return;
  const cols = process.stderr.columns ?? 80;
  if (visibleLength(prompt) + visibleLength(value) >= cols) return;
  process.stderr.write(`\x1b[1A\r\x1b[J${prompt}${c.bold(value)}\n`);
}

/** Re-prompt loop for a value that must start with https:// (or http://). */
export async function askUrl(p: Prompter, label: string): Promise<string> {
  const indent = /^\s*/.exec(label)![0];
  for (;;) {
    const ans = await p.askSecret(promptText(label, "hidden"));
    const padding = answerIndent(label) ?? indent;
    if (URL_RE.test(ans)) {
      process.stderr.write(`${padding}${mark("ok")} ${c.bold(webhookPreview(ans))}\n`);
      return ans;
    }
    warn(ans ? "The URL must start with https://" : "A value is required.", padding);
  }
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

/** Choice from a fixed list. Re-prompts on invalid input. */
export async function askChoice<T extends string>(
  p: Prompter,
  label: string,
  choices: readonly T[],
  def: T,
): Promise<T> {
  const indent = /^\s*/.exec(label)![0];
  // Shown with hyphens (`home-assistant`); typed either way.
  const shown = (x: string) => x.replace(/_/g, "-");
  for (;;) {
    // The choices sit on their own dim line, so the prompt reads the same
    // every time it is asked and never runs wide. In the form they sit in the
    // answer column, above the answer they describe.
    // A list that would take more than two lines there keeps its own line.
    const list = `one of: ${choices.map(shown).join(", ")}`;
    const col = answerIndent(label);
    const room = (process.stderr.columns ?? 80) - (col?.length ?? 0) - 1;
    const lines = col ? wrapProse(list, Math.max(20, room - 8)) : [];
    if (col && lines.length <= 2) {
      lines.forEach((line, i) => {
        process.stderr.write(`${col}${i ? "        " : ""}${c.dim(line)}\n`);
      });
    } else {
      process.stderr.write(`${indent}${c.dim(list)}\n`);
    }
    const prompt = promptText(label, shown(def));
    const ans = (await p.ask(prompt)).toLowerCase().replace(/-/g, "_");
    if (!ans) echoAccepted(prompt, shown(def));
    const v = (ans || def) as T;
    if ((choices as readonly string[]).includes(v)) return v;
    warn(`Pick one of: ${choices.map(shown).join(", ")}.`, answerIndent(label) ?? indent);
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
