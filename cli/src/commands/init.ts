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

  // Edge: generate a key, guide the user to set it on the worker, store it.
  const key = b64urlEncode(new Uint8Array(randomBytes(32)));
  w(`\n${c.green("✓")} generated an edge key.\n\n`);
  w(`${c.dim("1. Set it on your worker:")}\n`);
  w(`   cd mantis-edge && npx wrangler secret put MANTIS_EDGE_KEY\n`);
  w(`   ${c.dim("# paste this value:")} ${key}\n\n`);

  let worker = "";
  while (!URL_RE.test(worker)) {
    worker = await ask("2. Worker URL (https://…): ");
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
