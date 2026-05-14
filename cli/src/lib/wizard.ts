// Shared building blocks for the interactive wizards on `mantis new` and
// `mantis edge mint`. The two commands ask different questions about
// different state, but they share the same primitive prompts (channel
// pickers, channel-aware URL prompts, yes/no, choice-from-list) and the
// same channel-from-URL inference. Keeping them here means a change to
// inference rules or prompt UX lands once and applies everywhere.

import type { Prompter } from "./prompt.js";
import { c } from "./out.js";

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

/** Re-prompt loop for a value that must start with https:// (or http://). */
export async function askUrl(
  p: Prompter,
  label: string,
  opts: { default?: string; allowEmpty?: boolean } = {},
): Promise<string | undefined> {
  for (;;) {
    const def = opts.default ?? "";
    const prompt = def ? `${label} [${def}]: ` : `${label}: `;
    const ans = await p.ask(prompt);
    const v = ans || def;
    if (!v) {
      if (opts.allowEmpty) return undefined;
      writeWarn("a value is required.");
      continue;
    }
    if (URL_RE.test(v)) return v;
    writeWarn("must start with https:// — try again.");
  }
}

/** Yes/no with a typed default. `default: true` shows `[Y/n]`. */
export async function askYesNo(
  p: Prompter,
  label: string,
  defaultYes: boolean,
): Promise<boolean> {
  const suffix = defaultYes ? "[Y/n]" : "[y/N]";
  const ans = (await p.ask(`${label} ${suffix}: `)).toLowerCase();
  if (!ans) return defaultYes;
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
  const choiceText = choices.join(" / ");
  for (;;) {
    const ans = (
      await p.ask(`${label} (${choiceText}) [${def}]: `)
    ).toLowerCase();
    const v = (ans || def) as T;
    if ((choices as readonly string[]).includes(v)) return v;
    writeWarn(`must be one of ${choices.join(", ")}.`);
  }
}

/** Free-text prompt with optional default. Blank input returns default (or empty). */
export async function askText(
  p: Prompter,
  label: string,
  opts: { default?: string } = {},
): Promise<string> {
  const def = opts.default ?? "";
  const prompt = def ? `${label} [${def}]: ` : `${label}: `;
  const ans = await p.ask(prompt);
  return ans || def;
}

// ---------------------------------------------------------------------------
// Summary table + confirm/edit loop
// ---------------------------------------------------------------------------

export type SummaryRow = [label: string, value: string];

/** Print "Summary:" followed by an aligned label / value table. */
export function printSummary(rows: readonly SummaryRow[]): void {
  process.stderr.write(`\n${c.bold("Summary:")}\n`);
  const w = rows.reduce((max, [k]) => Math.max(max, k.length), 0);
  for (const [k, v] of rows) {
    process.stderr.write(`  ${c.dim(k.padEnd(w))}  ${v}\n`);
  }
  process.stderr.write("\n");
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
    const ans = (await p.ask("Proceed? [Y/n/edit]: ")).toLowerCase();
    if (ans === "" || ans === "y" || ans === "yes") return;
    if (ans === "n" || ans === "no") {
      process.stderr.write(`${c.yellow("aborted.")}\n`);
      process.exit(0);
    }
    if (ans === "edit" || ans === "e") {
      const which = (
        await p.ask(
          `Which field? [${fields.join("/")}] (blank to cancel): `,
        )
      ).toLowerCase();
      if (!which) continue;
      if (!fields.includes(which)) {
        writeWarn(`unknown field. Pick one of: ${fields.join(", ")}.`);
        continue;
      }
      await edit(which);
      continue;
    }
    writeWarn("answer y, n, or edit.");
  }
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

function writeWarn(msg: string): void {
  process.stderr.write(`  ${c.red("!")} ${msg}\n`);
}
