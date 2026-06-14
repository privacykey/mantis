import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve as resolvePath } from "node:path";
import { createInterface, type Interface } from "node:readline/promises";
import {
  getCurrentProfileName,
  getProfile,
  listProfiles,
} from "../lib/config.js";
import { b64urlDecode, b64urlEncode, seal } from "../lib/edge-crypto.js";
import { copyToClipboard } from "../lib/clipboard.js";
import {
  deleteEdgeKey,
  getEdgeKey,
  listEdgeKeyWorkers,
  setEdgeKey,
} from "../lib/edge-key.js";
import {
  ALL_INSTALL_TYPES,
  INSTALLER_META,
  applySshOnlyGuard,
  buildInstaller,
  isInstallType,
  type InstallType,
  type Installer,
} from "../lib/installers.js";
import { c, emit, fail } from "../lib/out.js";
import {
  URL_RE,
  inferChannelFromWebhook,
  webhookPromptLabel,
} from "../lib/wizard.js";

const RESPONSE_KINDS = ["gif", "empty", "json", "redirect", "html"] as const;
type ResponseKind = (typeof RESPONSE_KINDS)[number];
const CHANNELS = ["webhook", "slack", "discord", "teams"] as const;
type Channel = (typeof CHANNELS)[number];

function normalizeWorker(url: string): string {
  return url.replace(/\/$/, "");
}

function decodeKey(keyStr: string): Uint8Array {
  let raw: Uint8Array;
  try {
    raw = b64urlDecode(keyStr);
  } catch {
    fail("key is not valid base64url");
  }
  if (raw.length !== 32) {
    fail(`key must decode to 32 bytes, got ${raw.length}`);
  }
  return raw;
}

// ---------------------------------------------------------------------------
// keygen / set-key / delete-key (unchanged behaviour from before)
// ---------------------------------------------------------------------------

export function keygenCmd(): void {
  const key = b64urlEncode(new Uint8Array(randomBytes(32)));
  emit(
    () => {
      process.stdout.write(key + "\n");
      process.stderr.write(
        `\n${c.dim("# Set on the worker:")}\n` +
          `  cd mantis-edge && npx wrangler secret put MANTIS_EDGE_KEY\n` +
          `  ${c.dim("# paste the value above when prompted")}\n\n` +
          `${c.dim("# Save locally for minting:")}\n` +
          `  mantis edge set-key <worker-url>\n` +
          `  ${c.dim("# paste the key above when prompted")}\n`,
      );
    },
    { key },
  );
}

export async function setKeyCmd(opts: {
  worker?: string;
  key?: string;
}): Promise<void> {
  const worker = opts.worker;
  if (!worker || !URL_RE.test(worker)) {
    fail(
      "worker URL is required (https://…). Pass it as the first argument or via --worker.",
    );
  }
  const workerUrl = normalizeWorker(worker);

  let key = opts.key;
  if (!key) {
    const rl = createInterface({
      input: process.stdin,
      output: process.stderr,
    });
    try {
      key = (
        await rl.question(`edge key for ${workerUrl} (base64url, paste): `)
      ).trim();
    } finally {
      rl.close();
    }
  }
  if (!key) {
    fail("key is required");
  }
  decodeKey(key);
  setEdgeKey(workerUrl, key);
  emit(
    () => {
      process.stderr.write(
        `${c.green("✓")} stored edge key for ${c.cyan(workerUrl)}\n`,
      );
    },
    { worker: workerUrl, stored: true },
  );
}

export function deleteKeyCmd(opts: { worker?: string }): void {
  const worker = opts.worker;
  if (!worker || !URL_RE.test(worker)) {
    fail("--worker <url> is required");
  }
  const workerUrl = normalizeWorker(worker);
  deleteEdgeKey(workerUrl);
  emit(
    () => {
      process.stderr.write(
        `${c.green("✓")} cleared edge key for ${c.cyan(workerUrl)}\n`,
      );
    },
    { worker: workerUrl, deleted: true },
  );
}

// ---------------------------------------------------------------------------
// Per-installer response defaults + key-id derivation
// ---------------------------------------------------------------------------

/**
 * The trigger response that makes most sense for each installer flavour.
 * `empty` for back-channel curls (smallest payload, no rendering); `gif` for
 * browser-facing contexts that expect an image.
 */
const RESPONSE_FOR_INSTALL: Record<InstallType, ResponseKind> = {
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

// Grouped menu of installer types for the interactive wizard. Display order
// is fixed (POSIX first, IoT last) so users always see the same layout; types
// within each group follow INSTALLER_META's declaration order.
const OS_GROUP_ORDER: Installer["os"][] = [
  "posix",
  "macos",
  "linux",
  "windows",
  "web",
  "tag",
  "iot",
];

const OS_GROUP_LABELS: Record<Installer["os"], string> = {
  posix: "POSIX shells",
  macos: "macOS",
  linux: "Linux",
  windows: "Windows",
  web: "Web embed",
  tag: "NFC tag",
  iot: "Smart home / IoT",
};

/**
 * Print a grouped, numbered menu of all installer types to stderr and return
 * the types in display order so callers can map a chosen number back to a type.
 */
function printInstallerMenu(): InstallType[] {
  const byOs = new Map<Installer["os"], InstallType[]>();
  for (const type of ALL_INSTALL_TYPES) {
    const os = INSTALLER_META[type].os;
    const arr = byOs.get(os) ?? [];
    arr.push(type);
    byOs.set(os, arr);
  }

  const ordered: InstallType[] = [];
  process.stderr.write("  Installer types:\n");
  let idx = 0;
  // Width of the widest type slug, so the " — description" column lines up.
  const typeColumn = ALL_INSTALL_TYPES.reduce(
    (n, t) => Math.max(n, t.length),
    0,
  );
  for (const os of OS_GROUP_ORDER) {
    const types = byOs.get(os);
    if (!types?.length) continue;
    process.stderr.write(`    ${c.dim(OS_GROUP_LABELS[os])}\n`);
    for (const type of types) {
      idx++;
      ordered.push(type);
      const num = String(idx).padStart(2, " ");
      const slug = type.padEnd(typeColumn, " ");
      process.stderr.write(
        `      ${num}) ${slug}  ${c.dim("— " + INSTALLER_META[type].name)}\n`,
      );
    }
  }
  return ordered;
}

/** Stable short identifier for installer labels/filenames, derived from the URL. */
function deriveKeyIdFromUrl(url: string): string {
  // Use the last 8 chars of the encrypted blob. base64url charset, so it's
  // alphanumeric + `_-` — safe in filenames, plist labels, and systemd unit
  // names. The blob's collision domain is effectively the AES nonce, so the
  // last 8 chars are random enough not to collide across mints.
  const match = /\/c\/([A-Za-z0-9_-]+)$/.exec(url);
  const blob = match ? match[1]! : url;
  return blob.slice(-8) || "mantisedge";
}

// ---------------------------------------------------------------------------
// Installer surface: standalone `mantis edge install <url> --type <type>`
//                    and shared write-installer helper used by mint chain.
// ---------------------------------------------------------------------------

export type InstallerOpts = {
  type: string;
  out?: string;
  sshOnly?: boolean;
  hostname?: string;
  memo?: string;
};

export async function installCmd(
  url: string | undefined,
  opts: InstallerOpts,
): Promise<void> {
  if (!url || !URL_RE.test(url)) {
    fail(
      "url is required as the first argument (the URL printed by `mantis edge mint`)",
    );
  }
  await renderInstaller(url, opts);
}

/** Builds the installer snippet, writes to file or stdout, emits result. */
async function renderInstaller(
  url: string,
  opts: InstallerOpts,
): Promise<{ filename: string; written: string | null }> {
  const type = opts.type;
  if (!isInstallType(type)) {
    fail(
      `unknown installer type: ${type}. Available: ${ALL_INSTALL_TYPES.join(", ")}`,
    );
  }
  if (type === "js-clone-detector" && !opts.hostname) {
    fail(
      "`--hostname <host>` is required for js-clone-detector (the canary only fires on hostnames that don't match the expected one)",
    );
  }
  if (opts.sshOnly && type !== "shell" && type !== "shell-sudo") {
    fail(
      `--ssh-only only applies to shell / shell-sudo installers, not ${type}`,
    );
  }

  const installer = buildInstaller(type, {
    url,
    keyId: deriveKeyIdFromUrl(url),
    memo: opts.memo ?? "(stateless mantis-edge URL)",
    hostname: opts.hostname,
  });

  const content = opts.sshOnly
    ? applySshOnlyGuard(installer.content)
    : installer.content;

  let writtenTo: string | null = null;
  if (opts.out) {
    const target = resolvePath(opts.out);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, { encoding: "utf8", mode: 0o644 });
    writtenTo = target;
  }

  emit(
    () => {
      if (writtenTo) {
        process.stderr.write(
          `${c.green("✓")} wrote ${c.bold(installer.type)} installer to ${c.cyan(writtenTo)}\n`,
        );
        for (const line of installer.install) {
          process.stderr.write(`  ${c.dim(line)}\n`);
        }
      } else {
        // Snippet to stdout so users can pipe it.
        process.stdout.write(content);
      }
    },
    {
      type: installer.type,
      filename: installer.filename,
      mime: installer.mime,
      content: writtenTo ? undefined : content,
      written_to: writtenTo,
    },
  );

  return { filename: installer.filename, written: writtenTo };
}

// ---------------------------------------------------------------------------
// mint (wizard-aware) + chained install
// ---------------------------------------------------------------------------

export type MintOpts = {
  worker?: string;
  webhook?: string;
  channel?: string;
  responseKind?: string;
  responsePayload?: string;
  memo?: string;
  expiresAt?: string;
  key?: string;
  profile?: string;
  copy?: boolean;
  test?: boolean;
  install?: string;
  out?: string;
  sshOnly?: boolean;
  hostname?: string;
};

export async function mintCmd(opts: MintOpts): Promise<void> {
  // Resolve the worker from --worker or the profile default before deciding
  // whether to launch the wizard — the wizard's first prompt uses it as
  // default.
  if (!opts.worker) {
    const profileName = opts.profile ?? (await getCurrentProfileName());
    if (profileName) {
      const profile = await getProfile(profileName);
      if (profile?.edgeWorkerUrl) opts.worker = profile.edgeWorkerUrl;
    }
  }

  // Wizard kicks in only when we're on an interactive TTY AND the user is
  // missing at least one of the required pieces. Scripts piping into mint
  // with all flags set never see a prompt.
  const needsWizard =
    process.stdin.isTTY &&
    (!opts.worker ||
      !opts.webhook ||
      !URL_RE.test(opts.worker ?? "") ||
      !URL_RE.test(opts.webhook ?? ""));
  if (needsWizard) {
    await mintWizard(opts);
  }

  if (!opts.worker || !URL_RE.test(opts.worker)) {
    fail(
      "--worker <url> is required (https://…). Set a default with `mantis profile set-edge <name> --worker <url>`.",
    );
  }
  if (!opts.webhook || !URL_RE.test(opts.webhook)) {
    fail("--webhook <url> is required (https://…)");
  }

  const workerUrl = normalizeWorker(opts.worker);
  const keyStr = opts.key ?? getEdgeKey(workerUrl);
  if (!keyStr) {
    fail(
      `no edge key for ${workerUrl}. Run \`mantis edge set-key ${workerUrl}\` or pass --edge-key.`,
    );
  }
  const keyRaw = decodeKey(keyStr);

  const payload: Record<string, unknown> = { w: opts.webhook };

  if (opts.channel && opts.channel !== "webhook") {
    if (!(CHANNELS as readonly string[]).includes(opts.channel)) {
      fail(
        `invalid --channel: ${opts.channel}. Allowed: ${CHANNELS.join(", ")}`,
      );
    }
    payload.c = opts.channel as Channel;
  }

  if (opts.responseKind) {
    if (!(RESPONSE_KINDS as readonly string[]).includes(opts.responseKind)) {
      fail(
        `invalid --response-kind: ${opts.responseKind}. Allowed: ${RESPONSE_KINDS.join(", ")}`,
      );
    }
    payload.r = opts.responseKind as ResponseKind;
  }

  if (opts.responsePayload) {
    try {
      payload.p = JSON.parse(opts.responsePayload);
    } catch {
      fail("--response-payload is not valid JSON");
    }
  }

  if (opts.memo) payload.m = opts.memo;

  let expIso: string | null = null;
  if (opts.expiresAt) {
    const t = Date.parse(opts.expiresAt);
    if (Number.isNaN(t)) {
      fail(`--expires-at is not a valid ISO date: ${opts.expiresAt}`);
    }
    payload.exp = Math.floor(t / 1000);
    expIso = new Date(t).toISOString();
  }

  const sealed = await seal(JSON.stringify(payload), keyRaw);
  const blob = b64urlEncode(sealed);
  const url = `${workerUrl}/c/${blob}`;
  const copied = opts.copy ? await copyToClipboard(url) : null;
  const testResult = opts.test ? await testFire(url) : null;

  // Chained installer (--install <type>) runs after URL is produced. We
  // render it inline here so the user gets URL → test → installer in one
  // coherent stream, rather than spawning a second command.
  let installResult: { filename: string; written: string | null } | null = null;
  if (opts.install) {
    installResult = await renderInstaller(url, {
      type: opts.install,
      out: opts.out,
      sshOnly: opts.sshOnly,
      hostname: opts.hostname,
      memo: opts.memo,
    });
  }

  emit(
    () => {
      // Only print the URL to stdout if we didn't already write the
      // installer snippet to stdout (it would interleave noisily).
      if (!installResult || installResult.written) {
        process.stdout.write(url + "\n");
      }
      process.stderr.write(
        `${c.dim("length:")} ${url.length}` +
          (expIso ? `  ${c.dim("expires:")} ${expIso}` : "") +
          "\n",
      );
      if (copied !== null) {
        process.stderr.write(
          copied
            ? `${c.dim("copy:")} copied URL to clipboard\n`
            : `${c.yellow("copy:")} clipboard command not available\n`,
        );
      }
      if (testResult !== null) {
        writeTestResult(testResult, opts.channel ?? "webhook");
      }
      // installResult's stderr message already printed by renderInstaller.
      if (installResult && installResult.written) {
        process.stderr.write(
          `${c.dim("reload your shell or `source` the file to activate.")}\n`,
        );
      }
    },
    {
      url,
      length: url.length,
      expires_at: expIso,
      ...(copied !== null ? { copied } : {}),
      ...(testResult !== null ? { test: testResult } : {}),
      ...(installResult
        ? {
            installer: {
              type: opts.install,
              written_to: installResult.written,
            },
          }
        : {}),
    },
  );
}

// ---------------------------------------------------------------------------
// Interactive mint wizard
// ---------------------------------------------------------------------------

type Wizardish = MintOpts & { install?: string }; // alias for clarity

async function mintWizard(opts: Wizardish): Promise<void> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  try {
    // Always run through all prompts so the summary covers everything. Each
    // prompt accepts the existing opt value as the default and never
    // re-prompts a value the user already passed via flag.
    await askWorker(rl, opts);
    await askInstallerOrResponse(rl, opts);
    await askChannelAndWebhook(rl, opts);
    await askTest(rl, opts);
    await askMemo(rl, opts);

    // Summary + edit loop. Returns once user confirms or aborts.
    await confirmLoop(rl, opts);
  } finally {
    rl.close();
  }
}

/**
 * Workers the user has demonstrably set up before, unioned across two
 * sources: keys stored in the OS keychain (via `mantis edge set-key`) and
 * `edgeWorkerUrl` values stored on any profile. Used by the mint wizard to
 * auto-suggest defaults instead of making the user remember URLs.
 */
type KnownWorker = { url: string; profiles: string[] };

async function listKnownWorkers(): Promise<KnownWorker[]> {
  const [keychainUrls, profilesResult] = await Promise.all([
    listEdgeKeyWorkers(),
    listProfiles().catch(() => ({ current: null, profiles: [] })),
  ]);

  const profileMap = new Map<string, string[]>();
  for (const { name, entry } of profilesResult.profiles) {
    if (entry.edgeWorkerUrl) {
      const list = profileMap.get(entry.edgeWorkerUrl) ?? [];
      list.push(name);
      profileMap.set(entry.edgeWorkerUrl, list);
    }
  }

  const all = new Set<string>([...keychainUrls, ...profileMap.keys()]);
  return [...all]
    .sort((a, b) => a.localeCompare(b))
    .map((url) => ({ url, profiles: profileMap.get(url) ?? [] }));
}

async function askWorker(rl: Interface, opts: Wizardish): Promise<void> {
  if (opts.worker && URL_RE.test(opts.worker)) return;

  // Three shapes for this prompt depending on how much we already know:
  //   0 known workers → free-form URL (today's behaviour).
  //   1 known worker  → that URL becomes the default; user can override.
  //   2+ known        → numbered menu; user picks by number or pastes a new URL.
  const known = await listKnownWorkers();

  if (known.length === 0) {
    for (;;) {
      const ans = (
        await rl.question("Worker URL (https://…): ")
      ).trim();
      if (URL_RE.test(ans)) {
        opts.worker = normalizeWorker(ans);
        return;
      }
      process.stderr.write(
        `  ${c.red("!")} must start with https:// — try again.\n`,
      );
    }
  }

  if (known.length === 1) {
    const def = known[0]!.url;
    for (;;) {
      const ans = (
        await rl.question(`Worker URL [${def}]: `)
      ).trim();
      const v = ans || def;
      if (URL_RE.test(v)) {
        opts.worker = normalizeWorker(v);
        return;
      }
      process.stderr.write(
        `  ${c.red("!")} must start with https:// — try again.\n`,
      );
    }
  }

  process.stderr.write(
    "Worker URL — pick by number, or paste a new https:// URL:\n",
  );
  for (let i = 0; i < known.length; i++) {
    const w = known[i]!;
    const num = String(i + 1).padStart(2, " ");
    const annotation =
      w.profiles.length > 0
        ? `  ${c.dim(`(profile${w.profiles.length > 1 ? "s" : ""}: ${w.profiles.join(", ")})`)}`
        : "";
    process.stderr.write(`  ${num}) ${w.url}${annotation}\n`);
  }
  for (;;) {
    const ans = (
      await rl.question("Pick / paste new URL [1]: ")
    ).trim();
    const v = ans === "" ? "1" : ans;
    const num = Number(v);
    if (Number.isInteger(num) && num >= 1 && num <= known.length) {
      opts.worker = known[num - 1]!.url;
      return;
    }
    if (URL_RE.test(v)) {
      opts.worker = normalizeWorker(v);
      return;
    }
    process.stderr.write(
      `  ${c.red("!")} pick 1–${known.length} or paste an https:// URL\n`,
    );
  }
}

async function askInstallerOrResponse(
  rl: Interface,
  opts: Wizardish,
): Promise<void> {
  // Skip both prompts if the user pre-set --install or --response-kind:
  // the flag wins. Otherwise ask if they want an installer.
  if (opts.install || opts.responseKind) return;

  const yn = (
    await rl.question("Generate installer snippet? [y/N]: ")
  ).trim().toLowerCase();
  const wantsInstaller = yn === "y" || yn === "yes";
  if (!wantsInstaller) {
    await askResponseKind(rl, opts);
    return;
  }
  await askInstallerSubtree(rl, opts);
}

async function askInstallerSubtree(
  rl: Interface,
  opts: Wizardish,
): Promise<void> {
  // Show the grouped menu once, then loop on the prompt until we get a
  // valid pick. Accepts either a 1-based menu number or the type slug, so
  // returning users who know the name can still type it directly.
  const ordered = printInstallerMenu();
  for (;;) {
    const def = (opts.install && isInstallType(opts.install)) ? opts.install : "shell";
    const defIdx = ordered.indexOf(def) + 1;
    const ans = (
      await rl.question(`  Pick by number or name [${defIdx}=${def}]: `)
    ).trim();
    const v = ans || def;
    const num = Number(v);
    if (Number.isInteger(num) && num >= 1 && num <= ordered.length) {
      // Bounds-checked above, so this is always defined.
      opts.install = ordered[num - 1]!;
      break;
    }
    if (isInstallType(v)) {
      opts.install = v;
      break;
    }
    process.stderr.write(
      `    ${c.red("!")} not a valid choice. Pick a number 1–${ordered.length} or one of: ${ordered.join(", ")}\n`,
    );
  }

  // shell / shell-sudo: optional SSH-only guard
  if (opts.install === "shell" || opts.install === "shell-sudo") {
    if (opts.sshOnly === undefined) {
      const yn = (
        await rl.question("  SSH-only guard? [y/N]: ")
      ).trim().toLowerCase();
      opts.sshOnly = yn === "y" || yn === "yes";
    }
  }

  // js-clone-detector: required hostname
  if (opts.install === "js-clone-detector" && !opts.hostname) {
    for (;;) {
      const ans = (
        await rl.question("  Expected hostname (e.g. app.example.com): ")
      ).trim();
      if (ans) {
        opts.hostname = ans;
        break;
      }
      process.stderr.write(
        `    ${c.red("!")} hostname is required for js-clone-detector.\n`,
      );
    }
  }

  // Write target (blank = stdout)
  if (opts.out === undefined) {
    const ans = (
      await rl.question("  Write to file (blank = print to stdout): ")
    ).trim();
    if (ans) opts.out = ans;
  }

  // Set response default from the installer choice if user hasn't picked one.
  if (!opts.responseKind && isInstallType(opts.install)) {
    opts.responseKind = RESPONSE_FOR_INSTALL[opts.install];
    process.stderr.write(
      `  ${c.dim(`→ trigger response defaulting to \`${opts.responseKind}\` (suitable for ${opts.install}); edit later if you need something else.`)}\n`,
    );
  }
}

async function askResponseKind(rl: Interface, opts: Wizardish): Promise<void> {
  for (;;) {
    const def = opts.responseKind ?? "gif";
    const ans = (
      await rl.question(
        `Trigger response (${RESPONSE_KINDS.join(" / ")}) [${def}]: `,
      )
    ).trim();
    const v = ans || def;
    if ((RESPONSE_KINDS as readonly string[]).includes(v)) {
      opts.responseKind = v;
      return;
    }
    process.stderr.write(
      `  ${c.red("!")} must be one of ${RESPONSE_KINDS.join(", ")}.\n`,
    );
  }
}

async function askChannelAndWebhook(
  rl: Interface,
  opts: Wizardish,
): Promise<void> {
  // 1. Channel (skips if already provided)
  if (!opts.channel) {
    for (;;) {
      const def = "webhook";
      const ans = (
        await rl.question(
          `Notification channel (${CHANNELS.join(" / ")}) [${def}]: `,
        )
      ).trim().toLowerCase();
      const v = ans || def;
      if ((CHANNELS as readonly string[]).includes(v)) {
        opts.channel = v;
        break;
      }
      process.stderr.write(
        `  ${c.red("!")} must be one of ${CHANNELS.join(", ")}.\n`,
      );
    }
  }

  // 2. Channel-aware webhook URL prompt
  if (!opts.webhook || !URL_RE.test(opts.webhook)) {
    const label = webhookPromptLabel(opts.channel as Channel);
    for (;;) {
      const ans = (
        await rl.question(`${label}: `)
      ).trim();
      if (!URL_RE.test(ans)) {
        process.stderr.write(
          `  ${c.red("!")} must start with https:// — try again.\n`,
        );
        continue;
      }
      // Soft channel-vs-URL mismatch check
      const inferred = inferChannelFromWebhook(ans);
      if (inferred && opts.channel === "webhook") {
        // Auto-promote: user took the default channel but pasted a known
        // host. Show the inference and let them override.
        process.stderr.write(
          `  ${c.dim(`→ detected ${inferred} webhook host — using --channel ${inferred}. Pass --channel webhook to override.`)}\n`,
        );
        opts.channel = inferred;
      } else if (inferred && inferred !== opts.channel) {
        const fix = (
          await rl.question(
            `  ${c.yellow("!")} that looks like a ${inferred} URL but you picked --channel ${opts.channel}. ` +
              `Switch to ${inferred}? [Y/n]: `,
          )
        ).trim().toLowerCase();
        if (fix !== "n" && fix !== "no") {
          opts.channel = inferred;
        }
      }
      opts.webhook = ans;
      return;
    }
  }
}

async function askTest(rl: Interface, opts: Wizardish): Promise<void> {
  if (opts.test !== undefined) return;
  const yn = (
    await rl.question("Test fire after mint? [Y/n]: ")
  ).trim().toLowerCase();
  opts.test = yn !== "n" && yn !== "no";
}

async function askMemo(rl: Interface, opts: Wizardish): Promise<void> {
  if (opts.memo !== undefined) return;
  const ans = (
    await rl.question("Memo (optional, shown in notifications): ")
  ).trim();
  if (ans) opts.memo = ans;
}

async function confirmLoop(rl: Interface, opts: Wizardish): Promise<void> {
  for (;;) {
    printSummary(opts);
    const ans = (
      await rl.question("Proceed? [Y/n/edit]: ")
    ).trim().toLowerCase();
    if (ans === "" || ans === "y" || ans === "yes") return;
    if (ans === "n" || ans === "no") {
      process.stderr.write(`${c.yellow("aborted.")}\n`);
      process.exit(0);
    }
    if (ans === "edit" || ans === "e") {
      await editLoop(rl, opts);
      continue;
    }
    process.stderr.write(
      `  ${c.red("!")} answer y, n, or edit.\n`,
    );
  }
}

function printSummary(opts: Wizardish): void {
  process.stderr.write(`\n${c.bold("Summary:")}\n`);
  const rows: Array<[string, string]> = [["worker", opts.worker ?? "?"]];
  if (opts.install) {
    const bits: string[] = [opts.install];
    if (opts.sshOnly) bits.push("ssh-only");
    if (opts.hostname) bits.push(`hostname=${opts.hostname}`);
    bits.push(opts.out ? `→ ${opts.out}` : "→ stdout");
    rows.push(["installer", bits.join(" ")]);
  }
  rows.push(["response", opts.responseKind ?? "gif"]);
  rows.push(["channel", opts.channel ?? "webhook"]);
  rows.push(["webhook", opts.webhook ?? "?"]);
  rows.push(["test", opts.test ? "yes" : "no"]);
  rows.push(["memo", opts.memo ?? c.dim("(none)")]);

  const w = rows.reduce((max, [k]) => Math.max(max, k.length), 0);
  for (const [k, v] of rows) {
    process.stderr.write(`  ${c.dim(k.padEnd(w))}  ${v}\n`);
  }
  process.stderr.write("\n");
}

const EDITABLE_FIELDS = [
  "worker",
  "response",
  "installer",
  "channel",
  "webhook",
  "test",
  "memo",
] as const;

async function editLoop(rl: Interface, opts: Wizardish): Promise<void> {
  for (;;) {
    const ans = (
      await rl.question(
        `Which field? [${EDITABLE_FIELDS.join("/")}] (or blank to cancel edit): `,
      )
    ).trim().toLowerCase();
    if (!ans) return;
    if (!EDITABLE_FIELDS.includes(ans as never)) {
      process.stderr.write(
        `  ${c.red("!")} unknown field. Pick one of: ${EDITABLE_FIELDS.join(", ")}.\n`,
      );
      continue;
    }
    switch (ans) {
      case "worker":
        opts.worker = undefined;
        await askWorker(rl, opts);
        break;
      case "response":
        // Force the response prompt even if we're in install mode.
        opts.responseKind = undefined;
        await askResponseKind(rl, opts);
        break;
      case "installer":
        // Re-walk the whole installer subtree (yes/no, type, ssh-only, out).
        opts.install = undefined;
        opts.sshOnly = undefined;
        opts.out = undefined;
        await askInstallerOrResponse(rl, opts);
        break;
      case "channel":
        // Re-ask channel + webhook together: changing channel often changes
        // which webhook URL is valid (a Slack URL doesn't fit `--channel
        // discord`), and the URL prompt label is channel-aware.
        opts.channel = undefined;
        opts.webhook = undefined;
        await askChannelAndWebhook(rl, opts);
        break;
      case "webhook":
        opts.webhook = undefined;
        await askChannelAndWebhook(rl, opts);
        break;
      case "test":
        opts.test = undefined;
        await askTest(rl, opts);
        break;
      case "memo":
        opts.memo = undefined;
        await askMemo(rl, opts);
        break;
    }
    return;
  }
}

// ---------------------------------------------------------------------------
// Test-fire helper (unchanged from before)
// ---------------------------------------------------------------------------

type TestResult =
  | { ok: true; status: number }
  | { ok: false; status: number; body?: string }
  | { ok: false; status: 0; error: string };

async function testFire(url: string): Promise<TestResult> {
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 200) {
      return { ok: true, status: 200 };
    }
    const body = await res.text().catch(() => "");
    return { ok: false, status: res.status, body: body || undefined };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function writeTestResult(result: TestResult, channel: string): void {
  if (result.ok) {
    process.stderr.write(
      `${c.green("✓")} ${c.dim("test:")} worker accepted the URL (HTTP ${result.status}) and queued the webhook. ` +
        `Check your ${c.bold(channel)} destination — the worker fires asynchronously and can't observe its delivery.\n`,
    );
    return;
  }
  if (result.status === 0) {
    process.stderr.write(
      `${c.red("✗")} ${c.dim("test:")} could not reach worker — ${"error" in result ? result.error : "unknown"}\n`,
    );
    return;
  }
  if (result.status === 404) {
    process.stderr.write(
      `${c.red("✗")} ${c.dim("test:")} worker returned 404. Likely causes:\n` +
        `    • webhook host not in MANTIS_EDGE_WEBHOOK_ALLOWLIST (run \`npx wrangler secret list\`)\n` +
        `    • stored edge key differs from the deployed MANTIS_EDGE_KEY secret\n` +
        `    • URL was truncated in transit (try with --copy)\n`,
    );
    if ("body" in result && result.body) {
      process.stderr.write(`    body: ${result.body}\n`);
    }
    return;
  }
  process.stderr.write(
    `${c.yellow("!")} ${c.dim("test:")} unexpected worker status ${result.status}.` +
      ("body" in result && result.body ? ` body: ${result.body}` : "") +
      "\n",
  );
}
