import QRCode from "qrcode";
import { c, emit, fail, formatTime, isJsonMode, safeText } from "../lib/out.js";
import { copyToClipboard } from "../lib/clipboard.js";
import { resolveKeyRef, resolveKeyRefForAction } from "../lib/resolve.js";
import { withClient, type GlobalOpts } from "../lib/runner.js";

export type ShowOpts = GlobalOpts & {
  copy?: boolean;
  qrTerminal?: boolean;
  idOnly?: boolean;
  urlOnly?: boolean;
};

export async function showCmd(id: string, opts: ShowOpts): Promise<void> {
  if (opts.idOnly && opts.urlOnly) {
    fail("choose only one of --id-only or --url-only");
  }
  await withClient(opts, async (client) => {
    // --copy acts on the key (it replaces the clipboard), so a symbolic ref is
    // announced first; a plain show already prints the id and memo.
    const fullId = opts.copy
      ? await resolveKeyRefForAction(client, id)
      : await resolveKeyRef(client, id);
    const key = await client.getKey(fullId);
    const copied = opts.copy ? await copyToClipboard(key.url) : null;
    let qr: string | undefined;
    if (opts.qrTerminal && !isJsonMode()) {
      qr = await QRCode.toString(key.url, {
        type: "terminal",
        small: true,
        margin: 1,
      });
    }
    emit(
      () => {
        const s = safeText;
        if (opts.idOnly) {
          process.stdout.write(s(key.id) + "\n");
          return;
        }
        if (opts.urlOnly) {
          process.stdout.write(s(key.url) + "\n");
          return;
        }
        const w = process.stdout.write.bind(process.stdout);
        w(`${c.bold(s(key.id))}\n`);
        w(`${c.dim("public:    ")} ${s(key.public_id)}\n`);
        w(`${c.dim("url:       ")} ${c.cyan(s(key.url))}\n`);
        if (copied !== null) {
          w(
            copied
              ? `${c.dim("copy:      ")} copied URL to clipboard\n`
              : `${c.yellow("copy:      ")} clipboard command not available\n`,
          );
        }
        w(`${c.dim("memo:      ")} ${s(key.memo)}\n`);
        w(`${c.dim("kind:      ")} ${s(key.kind)}\n`);
        w(`${c.dim("response:  ")} ${s(key.response_kind)}\n`);
        w(`${c.dim("status:    ")} ${key.disabled ? c.red("disabled") : c.green("active")}\n`);
        w(`${c.dim("created:   ")} ${s(key.created_at)} (${formatTime(key.created_at)})\n`);
        if (key.expires_at) w(`${c.dim("expires:   ")} ${s(key.expires_at)}\n`);
        if (key.destinations.length > 0) {
          w(`${c.dim("destinations:")}\n`);
          for (const d of key.destinations) {
            const icon =
              d.last_activation_status === "ok"
                ? c.green("✓")
                : d.last_activation_status === "failed"
                ? c.red("⚠")
                : c.dim("·");
            w(`  ${icon} ${c.dim(s(d.channel).padEnd(7))} ${s(d.target)}\n`);
            if (
              d.last_activation_status === "failed" &&
              d.last_activation_error
            ) {
              w(`    ${c.dim("activation failed:")} ${s(d.last_activation_error)}\n`);
            }
          }
        }
        if (qr) w("\n" + qr);
      },
      copied === null ? key : { ...key, copied },
    );
  });
}
