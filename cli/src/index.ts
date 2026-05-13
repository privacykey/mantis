#!/usr/bin/env node
import { Command, Option } from "commander";
import {
  cloudflareLoginCmd,
  cloudflareLogoutCmd,
  cloudflareSetServiceAuthCmd,
  cloudflareStatusCmd,
} from "./commands/cloudflare.js";
import { bulkCreateCmd } from "./commands/bulk-create.js";
import { completionCmd } from "./commands/completion.js";
import { detectCmd } from "./commands/detect.js";
import { doctorCmd } from "./commands/doctor.js";
import {
  addDestinationCmd,
  listDestinationsCmd,
  rmDestinationCmd,
} from "./commands/destinations.js";
import { downloadCmd } from "./commands/download.js";
import {
  deleteKeyCmd as edgeDeleteKeyCmd,
  keygenCmd as edgeKeygenCmd,
  mintCmd as edgeMintCmd,
  setKeyCmd as edgeSetKeyCmd,
} from "./commands/edge.js";
import { hitsCmd } from "./commands/hits.js";
import { installCmd } from "./commands/install.js";
import { listCmd } from "./commands/list.js";
import { monitorCmd } from "./commands/monitor.js";
import { resetCmd } from "./commands/reset.js";
import { loginCmd } from "./commands/login.js";
import { logoutCmd } from "./commands/logout.js";
import { newCmd } from "./commands/new.js";
import { rmCmd } from "./commands/rm.js";
import { showCmd } from "./commands/show.js";
import { disableCmd, enableCmd } from "./commands/toggle.js";
import { watchCmd } from "./commands/watch.js";
import { whoamiCmd } from "./commands/whoami.js";
import { CLI_VERSION } from "./version.js";
import {
  c,
  fail,
  setJsonMode,
  setNoHeaders,
  setOutputMode,
  setQuiet,
  type OutputMode,
} from "./lib/out.js";

type GlobalRaw = {
  baseUrl?: string;
  key?: string;
  profile?: string;
  json?: boolean;
  quiet?: boolean;
  output?: OutputMode;
  headers?: boolean;
  timeout?: string;
  retries?: string;
};

function withGlobals<TOpts extends Record<string, unknown>>(
  program: Command,
  local: TOpts,
): TOpts & GlobalRaw {
  const globals = program.opts<GlobalRaw>();
  return { ...local, ...globals };
}

function collect(value: string, prev?: string[]): string[] {
  const arr = prev ?? [];
  arr.push(value);
  return arr;
}

const program = new Command();

program
  .name("mantis")
  .description("Mantis key CLI — self-hostable tripwires.")
  .version(CLI_VERSION, "-v, --version", "output the version number")
  .option("--base-url <url>", "override stored base URL")
  .option("--key <key>", "override stored API key")
  .option("-p, --profile <name>", "use a named profile (env: MANTIS_PROFILE)")
  .option("--json", "emit machine-readable JSON to stdout")
  .addOption(
    new Option("--output <mode>", "output mode")
      .choices(["table", "json", "wide"]),
  )
  .option("-q, --quiet", "suppress human-readable stdout")
  .option("--no-headers", "hide table headers")
  .option("--timeout <duration>", "request timeout (examples: 500ms, 5s, 1m)")
  .option("--retries <n>", "GET retry count for transient failures (0-5)")
  .hook("preAction", (cmd) => {
    const opts = cmd.opts<GlobalRaw>();
    if (opts.output) setOutputMode(opts.output);
    if (opts.json) setJsonMode(true);
    setQuiet(!!opts.quiet);
    setNoHeaders(opts.headers === false);
  });

program
  .command("login")
  .description("store API key for a profile (creates one if needed)")
  .option("-u, --url <url>", "Mantis server base URL (skips prompt)")
  .option("--no-switch", "save the profile but don't switch the current profile to it")
  .action(async (opts, cmd: Command) => {
    const globals = cmd.parent!.opts<GlobalRaw>();
    await loginCmd({
      url: opts.url ?? globals.baseUrl,
      key: globals.key,
      profile: globals.profile,
      noSwitch: opts.switch === false,
    });
  });

program
  .command("logout")
  .description("clear stored credentials for a profile (default: current)")
  .option("--all", "clear all profiles and the config file")
  .action(async (opts, cmd: Command) => {
    const globals = cmd.parent!.opts<GlobalRaw>();
    await logoutCmd({ profile: globals.profile, all: !!opts.all });
  });

program
  .command("whoami")
  .description("show current profile: server, key prefix, Cloudflare Access state, edge worker")
  .action(async (_opts, cmd: Command) => {
    const globals = cmd.parent!.opts<GlobalRaw>();
    await whoamiCmd({ profile: globals.profile });
  });

program
  .command("doctor")
  .description("check CLI config, server health, auth, and split public/private hosts")
  .option("--public-url <url>", "public trigger base URL to verify (auto-detected when a key exists)")
  .action(async (opts, cmd: Command) => {
    await doctorCmd(withGlobals(cmd.parent!, opts));
  });

program
  .command("detect")
  .description(
    "scan THIS machine for mantis-style installer artifacts (defensive self-audit, offline)",
  )
  .addOption(
    new Option("--scope <scope>", "what locations to scan")
      .choices(["user", "system", "all"])
      .default("user"),
  )
  .option("--verbose", "include matched line text in the report")
  .option(
    "--deep",
    "also walk $HOME for files containing mantis/canarytokens.*/canary.tools patterns (slow)",
  )
  .action(async (opts) => {
    await detectCmd(opts);
  });

const profile = program
  .command("profile")
  .description("manage CLI profiles (multiple mantis servers + edge workers)");

profile
  .command("list")
  .alias("ls")
  .description("list all stored profiles")
  .action(async () => {
    const { profileListCmd } = await import("./commands/profile.js");
    await profileListCmd();
  });

profile
  .command("current")
  .description("print the name of the active profile")
  .action(async () => {
    const { profileCurrentCmd } = await import("./commands/profile.js");
    await profileCurrentCmd();
  });

profile
  .command("use")
  .description("switch the active profile")
  .argument("<name>", "profile name to activate")
  .action(async (name: string) => {
    const { profileUseCmd } = await import("./commands/profile.js");
    await profileUseCmd(name);
  });

profile
  .command("show")
  .description("show one profile's details (default: current)")
  .argument("[name]", "profile name (defaults to current)")
  .action(async (name: string | undefined) => {
    const { profileShowCmd } = await import("./commands/profile.js");
    await profileShowCmd(name);
  });

profile
  .command("rm")
  .alias("delete")
  .description("remove a stored profile + its keychain entry")
  .argument("<name>", "profile name to delete")
  .option("-y, --yes", "skip confirmation")
  .action(async (name: string, opts: { yes?: boolean }) => {
    const { profileRmCmd } = await import("./commands/profile.js");
    await profileRmCmd(name, opts);
  });

profile
  .command("set-edge")
  .description("link a default mantis-edge worker URL to a profile (used by `mantis edge mint`)")
  .argument("<name>", "profile name")
  .option("--worker <url>", "edge worker base URL (https://…)")
  .option("--clear", "remove the linked worker")
  .action(
    async (
      name: string,
      opts: { worker?: string; clear?: boolean },
    ) => {
      const { profileSetEdgeCmd } = await import("./commands/profile.js");
      await profileSetEdgeCmd(name, opts);
    },
  );

const cloudflare = program
  .command("cloudflare")
  .description("manage Cloudflare Access auth for the mantis API");

cloudflare
  .command("login")
  .description("authenticate the CLI against Cloudflare Access (opens browser)")
  .option(
    "-a, --app <url>",
    "Cloudflare Access application URL (defaults to your mantis base URL)",
  )
  .action(async (opts) => {
    await cloudflareLoginCmd(opts);
  });

cloudflare
  .command("logout")
  .description("clear cached Cloudflare Access credentials")
  .action(async () => {
    await cloudflareLogoutCmd();
  });

cloudflare
  .command("set-service-auth")
  .description(
    "configure Cloudflare Access Service-Auth client-id + client-secret (for headless CLI usage)",
  )
  .option("--client-id <id>", "Service Auth Client-ID (ends in .access)")
  .option("--client-secret <secret>", "Service Auth Client-Secret")
  .action(async (opts) => {
    await cloudflareSetServiceAuthCmd(opts);
  });

cloudflare
  .command("status")
  .description("show Cloudflare Access auth state")
  .action(async () => {
    await cloudflareStatusCmd();
  });

const edge = program
  .command("edge")
  .description("manage stateless mantis-edge (Cloudflare Worker) keys");

edge
  .command("keygen")
  .description("generate a 32-byte AES key for a mantis-edge worker (prints to stdout)")
  .action(() => {
    edgeKeygenCmd();
  });

edge
  .command("set-key")
  .description("store an edge AES key in the OS keychain for a given worker URL")
  .option("--worker <url>", "worker base URL (https://…)")
  .option("--key <base64url>", "32-byte AES key, base64url-encoded")
  .action((opts) => {
    edgeSetKeyCmd(opts);
  });

edge
  .command("delete-key")
  .description("remove a stored edge key for a worker URL")
  .option("--worker <url>", "worker base URL")
  .action((opts) => {
    edgeDeleteKeyCmd(opts);
  });

edge
  .command("mint")
  .description("mint a stateless mantis-edge URL (no server round-trip; pure local crypto)")
  .option("--worker <url>", "worker base URL (https://…); falls back to current profile's edge worker")
  .option("--webhook <url>", "webhook URL the worker POSTs on hit")
  .addOption(
    new Option("--response-kind <kind>", "trigger response shape")
      .choices(["gif", "empty", "json", "redirect", "html"]),
  )
  .option("--response-payload <json>", "payload for json/redirect/html responses (JSON)")
  .option("--memo <text>", "memo, forwarded to the webhook for context")
  .option("--expires-at <iso>", "ISO timestamp after which the URL stops working")
  .option("--key <base64url>", "override stored AES key for one mint")
  .option("--copy", "copy the minted edge URL to the clipboard")
  .action(async (opts, cmd: Command) => {
    const globals = cmd.parent!.parent!.opts<GlobalRaw>();
    await edgeMintCmd({ ...opts, profile: globals.profile });
  });

program
  .command("new")
  .description("create a new mantis key")
  .argument("[memo]", "human-readable label for the key")
  .option(
    "-N, --notify <spec>",
    "notification destination as <channel>:<target>. Channels: webhook, email, slack, discord, teams. Repeatable.",
    collect,
    [] as string[],
  )
  .option("-w, --notify-webhook <url>", "shortcut for --notify webhook:<url>. Repeatable.", collect, [] as string[])
  .option("-e, --notify-email <email>", "shortcut for --notify email:<email>. Repeatable.", collect, [] as string[])
  .addOption(
    new Option("-r, --response-kind <kind>", "trigger response shape")
      .choices(["gif", "empty", "json", "redirect", "html"]),
  )
  .option("--response-payload <json>", "payload for json/redirect/html responses (JSON)")
  .option("--expires-at <iso>", "ISO timestamp at which the key disables itself")
  .option("--copy", "copy the created key URL to the clipboard")
  .option("--id-only", "print only the created key UUID")
  .option("--url-only", "print only the created trigger URL")
  .option("--qr <file>", "write a PNG QR code of the key URL to this path")
  .option("--docx <file>", "also generate a Word .docx file containing the mantis")
  .option("--xlsx <file>", "also generate an Excel .xlsx file containing the mantis")
  .option("--pptx <file>", "also generate a PowerPoint .pptx file containing the mantis")
  .option("--pdf <file>", "also generate a .pdf file containing the mantis")
  .option("--folder <file>", "also generate a honey-directory .zip bundle (multiple bait files)")
  .option("--svg <file>", "also generate an .svg image that fires on browser render (Immich/PhotoPrism)")
  .option("--html <file>", "also generate an .html page that fires on browser open")
  .option("--md <file>", "also generate a .md note that fires when rendered (Joplin/Trilium/Gitea)")
  .option("--eml <file>", "also generate an .eml email that fires when opened in a mail client")
  .option("--ics <file>", "also generate an .ics calendar event with image attachment URL")
  .option("--vcf <file>", "also generate a .vcf contact card with PHOTO URI")
  .action(async (memo: string | undefined, opts, cmd: Command) => {
    await newCmd(memo, withGlobals(cmd.parent!, opts));
  });

program
  .command("bulk-create")
  .alias("import-csv")
  .description("bulk create keys from a CSV and write an output CSV with URLs")
  .requiredOption("--csv <file>", "input CSV")
  .requiredOption("-o, --out <file>", "output CSV")
  .option("--memo-column <name>", "column to use as the memo")
  .option(
    "--memo-template <template>",
    "memo template using {{column}} placeholders, e.g. \"{{area}} - {{device}}\"",
  )
  .option(
    "-N, --notify <spec>",
    "destination for every row as <channel>:<target>. Channels: webhook, email, slack, discord, teams. Repeatable.",
    collect,
    [] as string[],
  )
  .option("-w, --notify-webhook <url>", "webhook destination for every row. Repeatable.", collect, [] as string[])
  .option("-e, --notify-email <email>", "email destination for every row. Repeatable.", collect, [] as string[])
  .addOption(
    new Option("-r, --response-kind <kind>", "default trigger response shape")
      .choices(["gif", "empty", "json", "redirect", "html"]),
  )
  .option("--response-payload <json>", "default payload for json/redirect/html responses")
  .option("--expires-at <iso>", "default ISO timestamp at which created keys disable themselves")
  .option("--concurrency <n>", "parallel create requests, 1-20", "4")
  .option("--fail-fast", "stop after the first row-level failure")
  .option("--dry-run", "validate rows and write the output CSV without creating keys")
  .action(async (opts, cmd: Command) => {
    await bulkCreateCmd(withGlobals(cmd.parent!, opts));
  });

program
  .command("download")
  .description("download generated files for an existing key")
  .argument("<id>", "key UUID, prefix (≥4 hex), or `last`")
  .option("--docx <file>", "save a Word .docx mantis to this path")
  .option("--xlsx <file>", "save an Excel .xlsx mantis to this path")
  .option("--pptx <file>", "save a PowerPoint .pptx mantis to this path")
  .option("--pdf <file>", "save a .pdf mantis to this path")
  .option("--folder <file>", "save a honey-directory .zip bundle to this path")
  .option("--nfc-label <file>", "save a printable NFC sticker PDF (QR fallback) to this path")
  .option("--apple-wallet <file>", "save a signed .pkpass Apple Wallet pass (requires APPLE_PASS_* env on server)")
  .option("--svg <file>", "save an .svg image (Immich/PhotoPrism) to this path")
  .option("--html <file>", "save an .html page to this path")
  .option("--md <file>", "save a .md note to this path")
  .option("--eml <file>", "save an .eml email message to this path")
  .option("--ics <file>", "save an .ics calendar event to this path")
  .option("--vcf <file>", "save a .vcf contact card to this path")
  .action(async (id: string, opts, cmd: Command) => {
    await downloadCmd(id, withGlobals(cmd.parent!, opts));
  });

program
  .command("monitor")
  .description("configure the Uptime Kuma status endpoint for a key")
  .argument("<id>", "key UUID, prefix (≥4 hex), or `last`")
  .addOption(
    new Option("-m, --mode <mode>", "monitor mode")
      .choices(["off", "latch", "window"]),
  )
  .option("-w, --window <seconds>", "window size in seconds (used with --mode window)")
  .action(async (id: string, opts, cmd: Command) => {
    await monitorCmd(id, withGlobals(cmd.parent!, opts));
  });

program
  .command("reset")
  .description("reset a key's tripped monitor state (latch mode)")
  .argument("<id>", "key UUID, prefix (≥4 hex), or `last`")
  .action(async (id: string, opts, cmd: Command) => {
    await resetCmd(id, withGlobals(cmd.parent!, opts));
  });

program
  .command("status")
  .description("show monitor state across keys, or details for one (window: hits + expiry; latch: hits since reset)")
  .argument("[id]", "key UUID, prefix, or `last`; omit for a summary across all monitored keys")
  .option("-n, --limit <n>", "max hits to consider (default: 50)", "50")
  .option("-w, --watch", "refresh continuously (default interval: 5s)")
  .option("-i, --interval <seconds>", "watch interval in seconds (used with --watch)", "5")
  .option("--tripped-only", "only show keys currently tripped (summary mode)")
  .action(async (id: string | undefined, opts, cmd: Command) => {
    const { statusCmd } = await import("./commands/status.js");
    await statusCmd(id, withGlobals(cmd.parent!, opts));
  });

program
  .command("last")
  .description("print the id of the most-recently-created key. Or pass `last` as the <id> argument on any command.")
  .action(async (_opts, cmd: Command) => {
    const { lastCmd } = await import("./commands/last.js");
    await lastCmd(withGlobals(cmd.parent!, {}));
  });

program
  .command("open")
  .description("open a key's dashboard page in the browser (or the dashboard root)")
  .argument("[id]", "key UUID, prefix, or `last`; omit to open the dashboard root")
  .option("--dashboard", "always open the dashboard root, even if id is supplied")
  .option("--trigger", "open the trigger URL instead of the dashboard page (fires the canary!)")
  .action(async (id: string | undefined, opts, cmd: Command) => {
    const { openCmd } = await import("./commands/open.js");
    await openCmd(id, withGlobals(cmd.parent!, opts));
  });

program
  .command("install")
  .description(
    "generate a host-install or web-embed snippet for a key (built-in or plugin-provided type)",
  )
  .argument("<id>", "key UUID, prefix (≥4 hex), or `last`")
  // No `.choices()` here — installer types are validated inside installCmd
  // against the union of built-ins + installed plugins. Hardcoding the
  // built-ins here would block plugin types from being accepted at parse
  // time. The command surfaces the full list in its error messages.
  .option(
    "-t, --type <type>",
    "installer type (run `mantis install` with no --type to see the list)",
  )
  .option("-o, --out <file>", "write the snippet to a file (default: stdout)")
  .option(
    "-H, --hostname <host>",
    "expected hostname (required for js-clone-detector; the snippet won't fire on this host or its subdomains)",
  )
  .action(async (id: string, opts, cmd: Command) => {
    await installCmd(id, withGlobals(cmd.parent!, opts));
  });

program
  .command("list")
  .alias("ls")
  .description("list keys")
  .option("-n, --limit <n>", "max number of keys to fetch", "50")
  .option("-a, --all", "fetch all pages")
  .option("--id-only", "print only key UUIDs")
  .option("--url-only", "print only trigger URLs")
  .action(async (opts, cmd: Command) => {
    await listCmd(withGlobals(cmd.parent!, opts));
  });

program
  .command("show")
  .description("show one key")
  .argument("<id>", "key UUID, prefix (≥4 hex), or `last`")
  .option("--copy", "copy the key URL to the clipboard")
  .option("--qr-terminal", "render the key URL as a QR code in the terminal")
  .option("--id-only", "print only the key UUID")
  .option("--url-only", "print only the trigger URL")
  .action(async (id: string, opts, cmd: Command) => {
    await showCmd(id, withGlobals(cmd.parent!, opts));
  });

program
  .command("rm")
  .alias("delete")
  .description("delete a key (cascades hits)")
  .argument("<id>", "key UUID, prefix (≥4 hex), or `last`")
  .option("-y, --yes", "skip confirmation")
  .action(async (id: string, opts, cmd: Command) => {
    await rmCmd(id, withGlobals(cmd.parent!, opts));
  });

program
  .command("disable")
  .description("disable a key (preserves history)")
  .argument("<id>", "key UUID, prefix (≥4 hex), or `last`")
  .action(async (id: string, opts, cmd: Command) => {
    await disableCmd(id, withGlobals(cmd.parent!, opts));
  });

program
  .command("enable")
  .description("re-enable a disabled key")
  .argument("<id>", "key UUID, prefix (≥4 hex), or `last`")
  .action(async (id: string, opts, cmd: Command) => {
    await enableCmd(id, withGlobals(cmd.parent!, opts));
  });

const destinations = program
  .command("destinations")
  .alias("dest")
  .description("incrementally manage notification destinations on a key");

destinations
  .command("list")
  .alias("ls")
  .description("list configured destinations for a key")
  .argument("<key-id>", "key UUID, prefix, or `last`")
  .action(async (keyId: string, opts, cmd: Command) => {
    await listDestinationsCmd(keyId, withGlobals(cmd.parent!.parent!, opts));
  });

destinations
  .command("add")
  .description("add a destination to a key (fires an activation ping)")
  .argument("<key-id>", "key UUID, prefix, or `last`")
  .argument("[channel]", "destination channel")
  .argument("[target]", "URL or email")
  .addOption(
    new Option("--channel <channel>", "destination channel").choices([
      "webhook",
      "email",
      "slack",
      "discord",
      "teams",
    ]),
  )
  .option("--target <target>", "URL or email")
  .action(async (
    keyId: string,
    channel: string | undefined,
    target: string | undefined,
    opts,
    cmd: Command,
  ) => {
    await addDestinationCmd(
      keyId,
      channel,
      target,
      withGlobals(cmd.parent!.parent!, opts),
    );
  });

destinations
  .command("rm")
  .alias("remove")
  .description("remove a destination from a key (id or unique prefix)")
  .argument("<key-id>", "key UUID, prefix, or `last`")
  .argument("<destination-id>", "destination UUID or unique prefix")
  .action(async (keyId: string, destId: string, opts, cmd: Command) => {
    await rmDestinationCmd(keyId, destId, withGlobals(cmd.parent!.parent!, opts));
  });

destinations
  .command("test")
  .description("fire a synthetic hit on the key URL and report which destinations succeeded")
  .argument("<key-id>", "key UUID, prefix, or `last`")
  .option("-y, --yes", "skip the confirmation prompt")
  .action(async (keyId: string, opts: { yes?: boolean }, cmd: Command) => {
    const { testDestinationCmd } = await import("./commands/destinations.js");
    await testDestinationCmd(keyId, withGlobals(cmd.parent!.parent!, opts));
  });

destinations
  .command("rotate-secret")
  .description("rotate the HMAC signing secret on a webhook destination (the new secret is shown once)")
  .argument("<key-id>", "key UUID, prefix, or `last`")
  .argument("<destination-id>", "destination UUID or unique prefix")
  .option("-y, --yes", "skip the confirmation prompt")
  .action(
    async (
      keyId: string,
      destId: string,
      opts: { yes?: boolean },
      cmd: Command,
    ) => {
      const { rotateDestinationSecretCmd } = await import(
        "./commands/destinations.js"
      );
      await rotateDestinationSecretCmd(
        keyId,
        destId,
        withGlobals(cmd.parent!.parent!, opts),
      );
    },
  );

const audit = program
  .command("audit")
  .description("read the append-only audit log (admin keys only)");

audit
  .command("log")
  .description("list audit events (most recent first)")
  .option("-n, --limit <n>", "page size (1-500, default 100)", "100")
  .option(
    "--since <duration>",
    "only events within the last duration (e.g. 30s, 5m, 2h, 1d) or ISO timestamp",
  )
  .option(
    "-t, --type <event_type>",
    "filter to one event type (e.g. key.created, session.login)",
  )
  .option("--actor <api_key_id>", "filter to events caused by a specific API key id")
  .action(async (opts, cmd: Command) => {
    const { auditLogCmd } = await import("./commands/audit.js");
    await auditLogCmd(withGlobals(cmd.parent!.parent!, opts));
  });

program
  .command("hits")
  .description("show recent hits for a key (filterable; --follow for live tail)")
  .argument("<id>", "key UUID, prefix (≥4 hex), or `last`")
  .option("-n, --limit <n>", "max hits to fetch", "50")
  .option("-v, --verbose", "show full headers")
  .option("--since <duration>", "filter to hits within the last duration (e.g. 30s, 5m, 2h, 1d) or ISO timestamp")
  .option("--ip <addr>", "filter to hits from this exact IP")
  .option("--bot-only", "only show hits flagged as bots")
  .option("-f, --follow", "stream new hits as they arrive (ctrl-c to stop)")
  .option("-i, --interval <seconds>", "poll interval when --follow (default: 3)", "3")
  .action(async (id: string, opts, cmd: Command) => {
    await hitsCmd(id, withGlobals(cmd.parent!, opts));
  });

program
  .command("watch")
  .description("poll for new hits and print them as they arrive")
  .option("--id <id>", "watch a single key only")
  .option("-i, --interval <seconds>", "poll interval in seconds", "5")
  .action(async (opts, cmd: Command) => {
    await watchCmd(withGlobals(cmd.parent!, opts));
  });

program
  .command("completion")
  .description("print shell completion script")
  .argument("<shell>", "bash, zsh, or fish")
  .action((shell: string) => {
    completionCmd(shell);
  });

const plugin = program
  .command("plugin")
  .description(
    "manage CLI plugins (third-party installer types + file formats; installed locally, never on the server)",
  );

plugin
  .command("add")
  .description("install a plugin from a GitHub repo (owner/repo[@ref]) or a local path")
  .argument(
    "<spec>",
    "GitHub spec (owner/repo, owner/repo@v1.0.0, owner/repo@<sha>) or local directory",
  )
  .action(async (spec: string) => {
    const { pluginAddCmd } = await import("./commands/plugin.js");
    await pluginAddCmd(spec);
  });

plugin
  .command("list")
  .alias("ls")
  .description("list installed plugins and what they provide")
  .action(async () => {
    const { pluginListCmd } = await import("./commands/plugin.js");
    await pluginListCmd();
  });

plugin
  .command("remove")
  .alias("rm")
  .description("uninstall a plugin")
  .argument("<name>", "plugin name (from `mantis plugin list`)")
  .action(async (name: string) => {
    const { pluginRemoveCmd } = await import("./commands/plugin.js");
    await pluginRemoveCmd(name);
  });

plugin
  .command("upgrade")
  .description("refresh a plugin from its source (errors out if pinned to a commit SHA)")
  .argument("<name>", "plugin name (from `mantis plugin list`)")
  .action(async (name: string) => {
    const { pluginUpgradeCmd } = await import("./commands/plugin.js");
    await pluginUpgradeCmd(name);
  });

program.addHelpText(
  "after",
  `
${c.bold("Common commands, grouped:")}

  ${c.dim("Auth & profiles")}
    login, logout, whoami, profile (list|use|show|rm|set-edge), cloudflare ...

  ${c.dim("Keys (create / inspect / lifecycle)")}
    new, bulk-create, list, show, last, open, disable, enable, rm

  ${c.dim("Hits & monitoring")}
    hits [--follow --since --ip --bot-only], watch,
    status [--watch --tripped-only], monitor, reset

  ${c.dim("Notifications")}
    destinations (list|add|rm|test|rotate-secret)  ${c.dim("(alias: dest)")}

  ${c.dim("Audit")}
    audit log [--since --type --actor]

  ${c.dim("File artifacts (drop-in canaries)")}
    download <id> --docx|xlsx|pptx|pdf|folder|svg|html|md|eml|ics|vcf|nfc-label|apple-wallet <path>

  ${c.dim("Host-event installers")}
    install <id> --type shell|*-login|*-boot|*-wake|*-network|css-background|js-clone-detector|nfc-ndef|homeassistant|scrypted

  ${c.dim("mantis-edge (stateless Cloudflare Worker)")}
    edge keygen, edge set-key, edge mint, edge delete-key

${c.bold("Tips:")}
  - Any <id> accepts a prefix (≥4 hex) or the literal ${c.cyan("last")} (most recent key).
    Example: ${c.dim("mantis hits last --follow")}
  - Use ${c.cyan("--profile <name>")} (or env ${c.cyan("MANTIS_PROFILE")}) to target a non-current profile.
  - Use ${c.cyan("--output json|table|wide")}, ${c.cyan("--quiet")}, ${c.cyan("--no-headers")}, or id/url-only flags for scripts.
`,
);

program
  .configureOutput({
    writeErr: (str) => process.stderr.write(c.red(str)),
  })
  .showHelpAfterError("(use --help for usage)")
  .showSuggestionAfterError();

program.parseAsync(process.argv).catch((err) => {
  fail(err instanceof Error ? err.message : String(err));
});
