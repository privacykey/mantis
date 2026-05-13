import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import QRCode from "qrcode";
import type { Key, NotificationChannel } from "../lib/api.js";
import { copyToClipboard } from "../lib/clipboard.js";
import { c, emit, fail, isJsonMode } from "../lib/out.js";
import { askRequired, canPrompt, createPrompter } from "../lib/prompt.js";
import { withClient, type GlobalOpts } from "../lib/runner.js";

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
};

const VALID_CHANNELS: NotificationChannel[] = [
  "webhook",
  "email",
  "slack",
  "discord",
  "teams",
];

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

function parseNotifySpec(
  spec: string,
): DestinationInput {
  // Form: <channel>:<target>. Target may contain colons (URLs do), so we
  // only split on the FIRST colon.
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
  const prompted = memoArg ? null : await promptForNewKey(opts);
  const memo = (memoArg ?? prompted?.memo ?? "").trim();
  if (!memo) {
    fail("memo is required. Run `mantis new` for the guided flow, or pass `mantis new \"my memo\"`.");
  }

  const effectiveOpts: NewOpts = {
    ...opts,
    ...(prompted?.files ?? {}),
    responseKind: opts.responseKind ?? prompted?.responseKind,
    responsePayload: opts.responsePayload ?? prompted?.responsePayload,
    expiresAt: opts.expiresAt ?? prompted?.expiresAt,
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

  await withClient(effectiveOpts, async (client) => {
    const key = await client.createKey({
      memo,
      ...(effectiveOpts.responseKind
        ? { response_kind: effectiveOpts.responseKind }
        : {}),
      ...(payload !== undefined ? { response_payload: payload } : {}),
      ...(destinations.length > 0 ? { destinations } : {}),
      ...(effectiveOpts.expiresAt ? { expires_at: effectiveOpts.expiresAt } : {}),
    });

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

    emit(
      () => {
        if (effectiveOpts.idOnly) {
          process.stdout.write(key.id + "\n");
          return;
        }
        if (effectiveOpts.urlOnly) {
          process.stdout.write(key.url + "\n");
          return;
        }
        process.stdout.write(`${c.green("✓")} created ${c.bold(key.id)}\n`);
        process.stdout.write(`  ${c.dim("memo:")}  ${key.memo}\n`);
        process.stdout.write(`  ${c.dim("url: ")} ${c.cyan(key.url)}\n`);
        if (copied !== null) {
          process.stdout.write(
            copied
              ? `  ${c.dim("copy:")} copied URL to clipboard\n`
              : `  ${c.yellow("copy:")} clipboard command not available\n`,
          );
        }
        if (key.destinations.length === 0) {
          process.stdout.write(
            `  ${c.yellow("warning:")} no notification destinations configured; hits will be logged only\n`,
          );
        }
        for (const d of key.destinations) {
          const activation = d.activation ?? {
            ok: d.last_activation_status === "ok",
            error:
              d.last_activation_status === "failed"
                ? d.last_activation_error ?? undefined
                : undefined,
          };
          const marker = activation.ok
            ? c.green("✓")
            : c.yellow("⚠");
          process.stdout.write(
            `  ${marker} ${c.dim(d.channel.padEnd(7))} ${d.target}\n`,
          );
          if (!activation.ok && activation.error) {
            process.stdout.write(
              `    ${c.dim("activation failed:")} ${activation.error}\n`,
            );
          }
        }
        if (qrAbsPath) {
          process.stdout.write(`  ${c.dim("qr:  ")} ${qrAbsPath}\n`);
        }
        for (const out of fileOutputs) {
          process.stdout.write(
            `  ${c.dim(out.format.padEnd(4) + ":")} ${out.path}\n`,
          );
        }
        if (qrTerminal) {
          process.stdout.write("\n" + qrTerminal);
        }
      },
      copied === null ? key : { ...key, copied },
    );
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

async function promptForNewKey(opts: NewOpts): Promise<{
  memo: string;
  responseKind?: Key["response_kind"];
  responsePayload?: string;
  expiresAt?: string;
  destinations: DestinationInput[];
  files: Partial<Pick<NewOpts, FileFormat>>;
}> {
  if (isJsonMode() || !canPrompt()) {
    fail("memo is required in non-interactive mode. Try `mantis new \"my memo\"`.");
  }

  const prompter = createPrompter();
  try {
    process.stderr.write(c.bold("Create a new mantis key\n"));
    const memo = await askRequired(prompter, "memo: ");

    const responseKind =
      opts.responseKind ?? (await askResponseKind(prompter));
    const responsePayload =
      opts.responsePayload ?? (await askResponsePayload(prompter, responseKind));

    const destinations =
      hasDestinationFlags(opts) ? [] : await askDestinations(prompter);

    const expiresAt = opts.expiresAt
      ? undefined
      : await askOptional(prompter, "expires at ISO time (blank for none): ");

    const files = await askFiles(prompter, opts);

    return {
      memo,
      responseKind,
      responsePayload,
      expiresAt: expiresAt || undefined,
      destinations,
      files,
    };
  } finally {
    prompter.close();
  }
}

async function askResponseKind(
  prompter: ReturnType<typeof createPrompter>,
): Promise<Key["response_kind"]> {
  for (;;) {
    const raw = (
      await prompter.ask(
        `response kind (${VALID_RESPONSE_KINDS.join("/")}) [gif]: `,
      )
    ).toLowerCase();
    const value = raw || "gif";
    if ((VALID_RESPONSE_KINDS as readonly string[]).includes(value)) {
      return value as Key["response_kind"];
    }
    process.stderr.write(`Choose one of: ${VALID_RESPONSE_KINDS.join(", ")}\n`);
  }
}

const VALID_RESPONSE_KINDS: Key["response_kind"][] = [
  "gif",
  "empty",
  "json",
  "redirect",
  "html",
];

async function askResponsePayload(
  prompter: ReturnType<typeof createPrompter>,
  kind: Key["response_kind"] | undefined,
): Promise<string | undefined> {
  switch (kind) {
    case "redirect": {
      const url = await askRequired(prompter, "redirect URL: ");
      return JSON.stringify({ url });
    }
    case "html": {
      const html = await askRequired(prompter, "HTML body: ");
      return JSON.stringify({ html });
    }
    case "json": {
      const raw = await askOptional(
        prompter,
        'JSON body [blank for {"ok":true}]: ',
      );
      return raw || undefined;
    }
    default:
      return undefined;
  }
}

async function askDestinations(
  prompter: ReturnType<typeof createPrompter>,
): Promise<DestinationInput[]> {
  const out: DestinationInput[] = [];
  process.stderr.write(
    "notification destinations: enter channel:target, a bare URL for webhook, or blank when done\n",
  );
  for (;;) {
    const raw = await askOptional(prompter, "destination: ");
    if (!raw) return out;
    try {
      const spec = /^https?:\/\//.test(raw) ? `webhook:${raw}` : raw;
      out.push(parseNotifySpec(spec));
    } catch (err) {
      process.stderr.write(
        `${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }
}

async function askFiles(
  prompter: ReturnType<typeof createPrompter>,
  opts: NewOpts,
): Promise<Partial<Pick<NewOpts, FileFormat>>> {
  if (FILE_FORMATS.some((fmt) => Boolean(opts[fmt]))) return {};

  const raw = await askOptional(
    prompter,
    `file outputs (${FILE_FORMATS.join(", ")}; blank for none): `,
  );
  if (!raw) return {};

  const files: Partial<Pick<NewOpts, FileFormat>> = {};
  for (const fmtRaw of raw.split(",")) {
    const fmt = fmtRaw.trim() as FileFormat;
    if (!fmt) continue;
    if (!(FILE_FORMATS as readonly string[]).includes(fmt)) {
      process.stderr.write(`Skipping unknown file format: ${fmt}\n`);
      continue;
    }
    const path = await askRequired(prompter, `${fmt} path: `);
    files[fmt] = path;
  }
  return files;
}

async function askOptional(
  prompter: ReturnType<typeof createPrompter>,
  question: string,
): Promise<string> {
  return prompter.ask(question);
}

function hasDestinationFlags(opts: NewOpts): boolean {
  return Boolean(
    opts.notify?.length ||
      opts.notifyWebhook?.length ||
      opts.notifyEmail?.length,
  );
}
