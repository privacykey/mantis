import { randomBytes } from "node:crypto";
import { b64urlEncode } from "../lib/edge-crypto.js";
import { setEdgeKey } from "../lib/edge-key.js";
import { c, fail, isJsonMode } from "../lib/out.js";
import { canPrompt, createPrompter } from "../lib/prompt.js";
import { loginCmd } from "./login.js";
import { newCmd } from "./new.js";

const URL_RE = /^https?:\/\/.+/;

// One short-lived prompter per question so we never hold a readline open across
// loginCmd / newCmd (which open their own on the same stdin).
async function ask(question: string): Promise<string> {
  const p = createPrompter();
  try {
    return await p.ask(question);
  } finally {
    p.close();
  }
}

export async function initCmd(): Promise<void> {
  if (isJsonMode() || !canPrompt()) {
    fail(
      "`mantis init` is interactive — run it in a terminal. For headless setup use `mantis login --key-stdin` or `mantis edge set-key`.",
    );
  }

  const w = process.stderr.write.bind(process.stderr);
  w(`${c.bold("Welcome to mantis.")} ${c.dim("Let's get you set up.")}\n\n`);
  w(`${c.dim("Two ways to use mantis:")}\n`);
  w(`  ${c.cyan("server")}  ${c.dim("— dashboard, hit history, multi-destination keys (needs a Mantis server)")}\n`);
  w(`  ${c.cyan("edge")}    ${c.dim("— stateless Cloudflare Worker, self-contained URLs (no server)")}\n\n`);

  let choice: "server" | "edge" | "" = "";
  while (!choice) {
    const a = (await ask("Set up [server/edge]? ")).toLowerCase();
    if (a === "s" || a === "server") choice = "server";
    else if (a === "e" || a === "edge") choice = "edge";
    else w(c.dim("Please type 'server' or 'edge'.\n"));
  }

  if (choice === "server") {
    // Interactive: prompts for URL + key, verifies, stores + selects profile.
    await loginCmd({});
    const yes = (await ask("Create your first key now? [Y/n] ")).toLowerCase();
    if (yes === "" || yes === "y" || yes === "yes") {
      await newCmd(undefined, {});
    }
    w(
      `\n${c.dim("Next:")} ${c.cyan("mantis hits last --follow")} ${c.dim("# tail hits live")}\n`,
    );
    return;
  }

  // Edge: generate a key, guide the user to deploy the worker, then store it.
  const key = b64urlEncode(new Uint8Array(randomBytes(32)));
  w(`\n${c.green("✓")} generated an edge key.\n\n`);
  w(`${c.dim("You'll deploy the Cloudflare Worker first — it doesn't exist yet,")}\n`);
  w(`${c.dim("and deploying is what gives you the *.workers.dev URL to paste below.")}\n`);
  w(`${c.dim("(The mantis-edge dir ships with the repo. If you installed via brew,")}\n`);
  w(`${c.dim(" clone it from https://github.com/privacykey/mantis or grab the worker")}\n`);
  w(`${c.dim(" from the deploy docs linked below.)")}\n\n`);

  w(`${c.dim("1. Deploy the worker (prints your *.workers.dev URL):")}\n`);
  w(`   ${c.cyan("mantis edge deploy")}   ${c.dim("# wraps wrangler deploy and captures the URL for you")}\n`);
  w(`   ${c.dim("# first time? run 'npx wrangler login' once, or set CLOUDFLARE_API_TOKEN")}\n\n`);
  w(`${c.dim("2. Set the edge key as a secret on the now-deployed worker:")}\n`);
  w(`   npx wrangler secret put MANTIS_EDGE_KEY\n`);
  w(`   ${c.dim("# paste this value:")} ${key}\n\n`);
  w(`${c.dim("Deploy docs:")} mantis-edge/README.md ${c.dim("·")} https://github.com/privacykey/mantis-docs\n\n`);

  let worker = "";
  while (!URL_RE.test(worker)) {
    worker = await ask("3. Worker URL from `wrangler deploy` (https://…), or blank to finish later: ");
    if (!worker) {
      w(
        `\n${c.dim("No problem — once the worker is deployed, store the key with:")}\n` +
          `   ${c.cyan("mantis edge set-key <worker-url>")}\n` +
          `   ${c.dim("# paste this value:")} ${key}\n`,
      );
      return;
    }
    if (!URL_RE.test(worker)) {
      w(c.dim("Enter a URL starting with http:// or https://\n"));
    }
  }
  worker = worker.replace(/\/$/, "");
  setEdgeKey(worker, key);
  w(`\n${c.green("✓")} stored the edge key for ${c.cyan(worker)} locally.\n`);
  w(
    `\n${c.dim("Next:")} ${c.cyan("mantis edge mint")} ${c.dim("# mint a stateless tripwire URL")}\n`,
  );
}
