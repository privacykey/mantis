import QRCode from "qrcode";
import { c, emit, fail, formatTime, isJsonMode } from "../lib/out.js";
import { copyToClipboard } from "../lib/clipboard.js";
import { resolveKeyRef } from "../lib/resolve.js";
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
    const fullId = await resolveKeyRef(client, id);
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
        if (opts.idOnly) {
          process.stdout.write(key.id + "\n");
          return;
        }
        if (opts.urlOnly) {
          process.stdout.write(key.url + "\n");
          return;
        }
        const w = process.stdout.write.bind(process.stdout);
        w(`${c.bold(key.id)}\n`);
        w(`${c.dim("public:    ")} ${key.public_id}\n`);
        w(`${c.dim("url:       ")} ${c.cyan(key.url)}\n`);
        if (copied !== null) {
          w(
            copied
              ? `${c.dim("copy:      ")} copied URL to clipboard\n`
              : `${c.yellow("copy:      ")} clipboard command not available\n`,
          );
        }
        w(`${c.dim("memo:      ")} ${key.memo}\n`);
        w(`${c.dim("kind:      ")} ${key.kind}\n`);
        w(`${c.dim("response:  ")} ${key.response_kind}\n`);
        w(`${c.dim("status:    ")} ${key.disabled ? c.red("disabled") : c.green("active")}\n`);
        w(`${c.dim("created:   ")} ${key.created_at} (${formatTime(key.created_at)})\n`);
        if (key.expires_at) w(`${c.dim("expires:   ")} ${key.expires_at}\n`);
        if (key.destinations.length > 0) {
          w(`${c.dim("destinations:")}\n`);
          for (const d of key.destinations) {
            const icon =
              d.last_activation_status === "ok"
                ? c.green("✓")
                : d.last_activation_status === "failed"
                ? c.red("⚠")
                : c.dim("·");
            w(`  ${icon} ${c.dim(d.channel.padEnd(7))} ${d.target}\n`);
            if (
              d.last_activation_status === "failed" &&
              d.last_activation_error
            ) {
              w(`    ${c.dim("activation failed:")} ${d.last_activation_error}\n`);
            }
          }
        }
        if (qr) w("\n" + qr);
      },
      copied === null ? key : { ...key, copied },
    );
  });
}
