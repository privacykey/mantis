import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import QRCode from "qrcode";
import type { Key, NotificationChannel } from "../lib/api.js";
import { copyToClipboard } from "../lib/clipboard.js";
import {
  ALL_INSTALL_TYPES,
  isInstallType,
  type InstallType,
} from "@mantis/core/installers";
import {
  arrow,
  c,
  emit,
  fail,
  heading,
  isJsonMode,
  kv,
  type KvRow,
  mark,
  safeText,
  stdoutPayload,
} from "../lib/out.js";
import { destinationLines } from "../lib/destination-format.js";
import { canPrompt, createPrompter, type Prompter } from "../lib/prompt.js";
import { withClient, type GlobalOpts } from "../lib/runner.js";
import { runInstaller } from "./install.js";
import {
  askChoice,
  askText,
  askUrl,
  askYesNo,
  confirmLoop,
  inferChannelFromWebhook,
  note,
  printSummary,
  warn,
  webhookPromptLabel,
  type SummaryRow,
} from "../lib/wizard.js";
import { ALL_CHANNELS } from "../lib/channels.js";

export type NewOpts = GlobalOpts & {
  notify?: string[];
  notifyWebhook?: string[];
  notifyEmail?: string[];
  responseKind?: Key["response_kind"];
  responsePayload?: string;
  expiresAt?: string;
  copy?: boolean;
  idOnly?: boolean;
  urlOnly?: boolean;
  qr?: string;
  docx?: string;
  xlsx?: string;
  pptx?: string;
  pdf?: string;
  folder?: string;
  svg?: string;
  html?: string;
  md?: string;
  eml?: string;
  ics?: string;
  vcf?: string;
  // Installer chain (mirrors `mantis edge mint --install ...`)
  install?: string;
  out?: string;
  sshOnly?: boolean;
  hostname?: string;
};

const VALID_CHANNELS = ALL_CHANNELS;

const FILE_FORMATS = [
  "qr",
  "docx",
  "xlsx",
  "pptx",
  "pdf",
  "folder",
  "svg",
  "html",
  "md",
  "eml",
  "ics",
  "vcf",
] as const;

type FileFormat = (typeof FILE_FORMATS)[number];
type DestinationInput = { channel: NotificationChannel; target: string };

const RESPONSE_KINDS: Key["response_kind"][] = [
  "gif",
  "empty",
  "json",
  "redirect",
  "html",
];

/**
 * The trigger response that makes sense per installer flavour. `empty` for
 * back-channel curls; `gif` for browser-facing CSS / NFC contexts.
 */
const RESPONSE_FOR_INSTALL: Record<InstallType, Key["response_kind"]> = {
  shell: "empty",
  "shell-sudo": "empty",
  "macos-login": "empty",
  "macos-boot": "empty",
  "macos-wake": "empty",
  "macos-network": "empty",
  "linux-boot": "empty",
  "linux-wake": "empty",
  "linux-network": "empty",
  "windows-logon": "empty",
  "windows-wake": "empty",
  "windows-network": "empty",
  "css-background": "gif",
  "js-clone-detector": "empty",
  "nfc-ndef": "gif",
  homeassistant: "empty",
  "homeassistant-receiver": "empty",
  scrypted: "empty",
};

function parseNotifySpec(spec: string): DestinationInput {
  const idx = spec.indexOf(":");
  if (idx <= 0) {
    throw new Error(
      `--notify expects <channel>:<target>. Got: ${spec}. Channels: ${VALID_CHANNELS.join(", ")}`,
    );
  }
  const channelRaw = spec.slice(0, idx);
  const target = spec.slice(idx + 1);
  if (!(VALID_CHANNELS as readonly string[]).includes(channelRaw)) {
    throw new Error(
      `unknown channel "${channelRaw}". Valid: ${VALID_CHANNELS.join(", ")}`,
    );
  }
  if (!target) {
    throw new Error(`--notify ${channelRaw}: empty target`);
  }
  return { channel: channelRaw as NotificationChannel, target };
}

export async function newCmd(
  memoArg: string | undefined,
  opts: NewOpts,
): Promise<void> {
  if (opts.idOnly && opts.urlOnly) {
    fail("choose only one of --id-only or --url-only");
  }
  const prompted = memoArg ? null : await runWizard(opts);
  const memo = (memoArg ?? prompted?.memo ?? "").trim();
  if (!memo) {
    fail(
      'memo is required. Run `mantis new` for the guided flow, or pass `mantis new "my memo"`.',
    );
  }

  const effectiveOpts: NewOpts = {
    ...opts,
    ...(prompted?.files ?? {}),
    responseKind: opts.responseKind ?? prompted?.responseKind,
    responsePayload: opts.responsePayload ?? prompted?.responsePayload,
    expiresAt: opts.expiresAt ?? prompted?.expiresAt,
    copy: opts.copy ?? prompted?.copy,
    install: opts.install ?? prompted?.install,
    out: opts.out ?? prompted?.out,
    sshOnly: opts.sshOnly ?? prompted?.sshOnly,
    hostname: opts.hostname ?? prompted?.hostname,
  };

  let payload: unknown;
  if (effectiveOpts.responsePayload) {
    try {
      payload = JSON.parse(effectiveOpts.responsePayload);
    } catch {
      throw new Error("--response-payload must be valid JSON");
    }
  }

  const destinations = [
    ...(opts.notify ?? []).map(parseNotifySpec),
    ...(opts.notifyWebhook ?? []).map((target) =>
      destinationFromAlias("webhook", target),
    ),
    ...(opts.notifyEmail ?? []).map((target) =>
      destinationFromAlias("email", target),
    ),
    ...(prompted?.destinations ?? []),
  ];

  // Validate installer flags before the network call so we fail fast.
  if (effectiveOpts.install && !isInstallType(effectiveOpts.install)) {
    fail(
      `unknown installer type "${effectiveOpts.install}". Available: ${ALL_INSTALL_TYPES.join(", ")}`,
    );
  }
  if (effectiveOpts.install && !effectiveOpts.out && (effectiveOpts.idOnly || effectiveOpts.urlOnly)) {
    fail("--install needs --out when used with --id-only or --url-only; otherwise the snippet has nowhere to go");
  }

  await withClient(effectiveOpts, async (client) => {
    const key = await client.createKey({
      memo,
      ...(effectiveOpts.responseKind
        ? { response_kind: effectiveOpts.responseKind }
        : {}),
      ...(payload !== undefined ? { response_payload: payload } : {}),
      ...(destinations.length > 0 ? { destinations } : {}),
      ...(effectiveOpts.expiresAt
        ? { expires_at: effectiveOpts.expiresAt }
        : {}),
    });

    try {
      let qrAbsPath: string | undefined;
      let qrTerminal: string | undefined;
      if (effectiveOpts.qr) {
        qrAbsPath = resolve(effectiveOpts.qr);
        await QRCode.toFile(qrAbsPath, key.url, {
          margin: 4,
          width: 512,
          errorCorrectionLevel: "M",
          color: { dark: "#000000", light: "#ffffff" },
        });
        if (!isJsonMode()) {
          qrTerminal = await QRCode.toString(key.url, {
            type: "terminal",
            small: true,
            margin: 1,
          });
        }
      }

      const fileOutputs: Array<{ format: string; path: string }> = [];
      for (const fmt of FILE_FORMATS.filter((f) => f !== "qr")) {
        const target = effectiveOpts[fmt];
        if (!target) continue;
        const abs = resolve(target);
        const { data } = await client.downloadFile(key.id, fmt);
        await writeFile(abs, data);
        fileOutputs.push({ format: fmt, path: abs });
      }

      const copied = effectiveOpts.copy
        ? await copyToClipboard(key.url)
        : null;

      // Chain into the installer if requested. Uses the same client + the
      // freshly-created key id; no redundant withClient or extra round-trip
      // to resolve `last`/prefix.
      let installerResult: { filename: string; writtenTo: string | null; content: string } | null =
        null;
      if (effectiveOpts.install) {
        installerResult = await runInstaller(client, key.id, {
          type: effectiveOpts.install,
          out: effectiveOpts.out,
          hostname: effectiveOpts.hostname,
          sshOnly: effectiveOpts.sshOnly,
          silent: true, // we emit the combined output below
        });
      }

      emit(
        () => {
          if (effectiveOpts.idOnly) {
            process.stdout.write(safeText(key.id) + "\n");
            return;
          }
          if (effectiveOpts.urlOnly) {
            process.stdout.write(safeText(key.url) + "\n");
            return;
          }
          process.stdout.write(
            `${mark("ok")} Created ${heading(safeText(key.memo), safeText(key.id).slice(0, 8))}\n`,
          );
          const rows: KvRow[] = [
            ["url", c.cyan(safeText(key.url))],
            ["id", safeText(key.id)],
          ];
          if (copied !== null) {
            rows.push([
              "clipboard",
              copied
                ? `${mark("ok")} URL copied`
                : `${mark("warn")} ${c.yellow("no clipboard command available")}`,
            ]);
          }
          rows.push([
            "destinations",
            key.destinations.length === 0
              ? `${mark("warn")} ${c.yellow("none, so hits will only be logged")}`
              : destinationLines(
                  key.destinations.map((d) => {
                    // The create call reports each activation as it happens.
                    const ok = d.activation
                      ? d.activation.ok
                      : d.last_activation_status === "ok";
                    const error =
                      d.activation?.error ?? d.last_activation_error ?? null;
                    return {
                      channel: d.channel,
                      target: d.target,
                      last_activation_status: ok
                        ? ("ok" as const)
                        : error
                          ? ("failed" as const)
                          : null,
                      last_activation_error: ok ? null : error,
                    };
                  }),
                ),
          ]);
          if (qrAbsPath) rows.push(["qr", qrAbsPath]);
          for (const out of fileOutputs) rows.push([out.format, out.path]);
          if (installerResult?.writtenTo) {
            rows.push([
              "installer",
              `${effectiveOpts.install} ${arrow.right()} ${installerResult.writtenTo}`,
            ]);
          } else if (installerResult && !installerResult.writtenTo) {
            rows.push(["installer", `${effectiveOpts.install}, snippet below`]);
          }
          process.stdout.write(kv(rows));
          if (qrTerminal) {
            process.stdout.write("\n" + qrTerminal);
          }
          if (installerResult && !installerResult.writtenTo) {
            process.stdout.write("\n" + stdoutPayload(installerResult.content));
          }
        },
        {
          ...(copied === null ? key : { ...key, copied }),
          ...(installerResult
            ? {
                installer: {
                  type: effectiveOpts.install,
                  written_to: installerResult.writtenTo,
                  ...(!installerResult.writtenTo ? { content: installerResult.content } : {}),
                },
              }
            : {}),
        },
      );
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      const recovery = effectiveOpts.install
        ? `Finish the installer with \`mantis install ${key.id} --type ${effectiveOpts.install}\`.`
        : `Inspect the key with \`mantis show ${key.id}\`.`;
      throw new Error(`key ${key.id} was created, but setup did not finish: ${reason}. ${recovery}`);
    }
  });
}

function destinationFromAlias(
  channel: NotificationChannel,
  rawTarget: string,
): DestinationInput {
  const target = rawTarget.trim();
  if (!target) throw new Error(`--notify-${channel}: empty target`);
  return { channel, target };
}

// ---------------------------------------------------------------------------
// Interactive wizard (mirrors `mantis edge mint`'s wizard)
// ---------------------------------------------------------------------------

type WizardResult = {
  memo: string;
  responseKind?: Key["response_kind"];
  responsePayload?: string;
  expiresAt?: string;
  destinations: DestinationInput[];
  files: Partial<Pick<NewOpts, FileFormat>>;
  copy?: boolean;
  install?: string;
  out?: string;
  sshOnly?: boolean;
  hostname?: string;
};

async function runWizard(opts: NewOpts): Promise<WizardResult> {
  if (isJsonMode() || !canPrompt()) {
    fail('memo is required in non-interactive mode. Try `mantis new "my memo"`.');
  }

  const state: WizardResult = {
    memo: "",
    destinations: [],
    files: {},
    responseKind: opts.responseKind,
    responsePayload: opts.responsePayload,
    expiresAt: opts.expiresAt,
    copy: opts.copy,
    install: opts.install,
    out: opts.out,
    sshOnly: opts.sshOnly,
    hostname: opts.hostname,
  };

  const p = createPrompter();
  try {
    process.stderr.write(c.bold("Create a new mantis key\n\n"));

    await askMemo(p, state);
    await askInstallerOrResponse(p, state);
    await askDestinationsLoop(p, state, opts);
    await askExpiry(p, state);
    await askCopy(p, state);

    await confirmLoop(
      p,
      () => printNewSummary(state),
      ["memo", "installer", "response", "destinations", "expires", "clipboard"],
      (field) => editField(p, state, opts, field),
    );

    return state;
  } finally {
    p.close();
  }
}

async function askMemo(p: Prompter, state: WizardResult): Promise<void> {
  for (;;) {
    const ans = (
      await askText(p, "Memo", { default: state.memo })
    ).trim();
    if (ans) {
      state.memo = ans;
      return;
    }
    warn("A memo is required.");
  }
}

async function askInstallerOrResponse(
  p: Prompter,
  state: WizardResult,
): Promise<void> {
  // If the user pre-set --install on the command line, use that and skip
  // the y/n. Otherwise ask.
  if (state.install) {
    await askInstallerSubtree(p, state);
    return;
  }
  if (state.responseKind) return; // pre-set via flag

  const yes = await askYesNo(p, "Generate installer snippet?", false);
  if (yes) {
    await askInstallerSubtree(p, state);
  } else {
    await askResponseKindPrompt(p, state);
  }
}

async function askInstallerSubtree(
  p: Prompter,
  state: WizardResult,
): Promise<void> {
  // Type
  for (;;) {
    const def =
      state.install && isInstallType(state.install) ? state.install : "shell";
    const ans = (await askText(p, "  Installer type", { default: def })).trim();
    if (isInstallType(ans)) {
      state.install = ans;
      break;
    }
    process.stderr.write(
      `    ${mark("fail")} ${c.red(`Unknown type. Available:`)}\n` +
        `    ${ALL_INSTALL_TYPES.join(", ")}\n`,
    );
  }

  if (state.install === "shell" || state.install === "shell-sudo") {
    if (state.sshOnly === undefined) {
      state.sshOnly = await askYesNo(p, "  SSH-only guard?", false);
    }
  } else {
    state.sshOnly = undefined;
  }

  if (state.install === "js-clone-detector" && !state.hostname) {
    for (;;) {
      const ans = (
        await askText(p, "  Expected hostname (e.g. app.example.com)")
      ).trim();
      if (ans) {
        state.hostname = ans;
        break;
      }
      process.stderr.write(
        `    ${mark("fail")} ${c.red(`Hostname is required for js-clone-detector.`)}\n`,
      );
    }
  }

  if (state.out === undefined) {
    const ans = (
      await askText(p, "  Write to file", { blank: "stdout" })
    ).trim();
    if (ans) state.out = ans;
  }

  if (!state.responseKind && isInstallType(state.install)) {
    state.responseKind = RESPONSE_FOR_INSTALL[state.install];
    note(
      `${arrow.right()} Response set to ${state.responseKind}, which suits ${state.install}. Edit the key later to change it.`,
      "  ",
    );
  }
}

async function askResponseKindPrompt(
  p: Prompter,
  state: WizardResult,
): Promise<void> {
  state.responseKind = await askChoice(
    p,
    "Trigger response",
    RESPONSE_KINDS,
    state.responseKind ?? ("gif" as Key["response_kind"]),
  );
}

async function askDestinationsLoop(
  p: Prompter,
  state: WizardResult,
  opts: NewOpts,
): Promise<void> {
  if (hasDestinationFlags(opts)) return; // flags supply destinations; skip wizard

  // First destination — "Add ...?" with default yes (most users want at least one).
  for (let i = 0; ; i++) {
    const prompt = i === 0 ? "Add a notification destination?" : "Add another destination?";
    const yes = await askYesNo(p, prompt, i === 0);
    if (!yes) return;
    const dest = await askOneDestination(p);
    if (dest) state.destinations.push(dest);
  }
}

async function askOneDestination(
  p: Prompter,
): Promise<DestinationInput | null> {
  const channel = await askChoice(
    p,
    "  Channel",
    VALID_CHANNELS,
    "webhook" as NotificationChannel,
  );

  if (channel === "email") {
    for (;;) {
      const ans = (await askText(p, "  Email address")).trim();
      if (!ans) {
        process.stderr.write(`    ${mark("fail")} ${c.red(`Address is required.`)}\n`);
        continue;
      }
      // Light syntactic check; the server does the real validation on
      // activation.
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ans)) {
        process.stderr.write(
          `    ${mark("fail")} ${c.red(`Doesn't look like an email address.`)}\n`,
        );
        continue;
      }
      return { channel, target: ans };
    }
  }

  // URL-style channels: ask with channel-aware label + host inference.
  const label = `  ${webhookPromptLabel(channel)}`;
  for (;;) {
    const ans = await askUrl(p, label);
    if (!ans) continue;
    const inferred = inferChannelFromWebhook(ans);
    if (inferred && inferred !== channel && channel === "webhook") {
      note(
        `${arrow.right()} That is a ${inferred} webhook, so the channel is now ${inferred}. Edit the destination to override.`,
        "    ",
      );
      return { channel: inferred as NotificationChannel, target: ans };
    }
    if (inferred && inferred !== channel && channel !== "webhook") {
      const fix = await askYesNo(
        p,
        `    ${mark("warn")} That looks like a ${inferred} URL but you picked ${channel}. Switch to ${inferred}?`,
        true,
      );
      if (fix) {
        return { channel: inferred as NotificationChannel, target: ans };
      }
    }
    return { channel, target: ans };
  }
}

async function askExpiry(
  p: Prompter,
  state: WizardResult,
): Promise<void> {
  if (state.expiresAt !== undefined) return;
  const ans = (
    await askText(p, "Expires at, ISO timestamp", { blank: "never" })
  ).trim();
  if (ans) state.expiresAt = ans;
}

async function askCopy(p: Prompter, state: WizardResult): Promise<void> {
  if (state.copy !== undefined) return;
  state.copy = await askYesNo(p, "Copy URL to clipboard?", false);
}

function printNewSummary(state: WizardResult): void {
  const rows: SummaryRow[] = [["memo", state.memo]];
  if (state.install) {
    const bits: string[] = [state.install];
    if (state.sshOnly) bits.push("ssh-only");
    if (state.hostname) bits.push(`hostname ${state.hostname}`);
    rows.push([
      "installer",
      `${bits.join(", ")} ${arrow.right()} ${state.out ?? "stdout"}`,
    ]);
  }
  rows.push(["response", state.responseKind ?? "gif"]);
  if (state.destinations.length === 0) {
    rows.push(["destinations", "none, so hits will only be logged"]);
  } else {
    const width = Math.max(...state.destinations.map((d) => d.channel.length));
    rows.push([
      "destinations",
      state.destinations.map((d) => `${d.channel.padEnd(width)}  ${d.target}`),
    ]);
  }
  rows.push(["expires", state.expiresAt ?? "never"]);
  rows.push(["clipboard", state.copy ? "copy the URL" : "no"]);
  printSummary(rows);
}

async function editField(
  p: Prompter,
  state: WizardResult,
  opts: NewOpts,
  field: string,
): Promise<void> {
  switch (field) {
    case "memo":
      state.memo = "";
      await askMemo(p, state);
      break;
    case "installer":
      state.install = undefined;
      state.sshOnly = undefined;
      state.out = undefined;
      state.hostname = undefined;
      await askInstallerOrResponse(p, state);
      break;
    case "response":
      state.responseKind = undefined;
      await askResponseKindPrompt(p, state);
      break;
    case "destinations":
      state.destinations = [];
      await askDestinationsLoop(p, state, opts);
      break;
    case "expires":
      state.expiresAt = undefined;
      await askExpiry(p, state);
      break;
    case "clipboard":
      state.copy = undefined;
      await askCopy(p, state);
      break;
  }
}

function hasDestinationFlags(opts: NewOpts): boolean {
  return Boolean(
    opts.notify?.length ||
      opts.notifyWebhook?.length ||
      opts.notifyEmail?.length,
  );
}
