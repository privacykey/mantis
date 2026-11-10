import QRCode from "qrcode";
import {
  c,
  dot,
  emit,
  fail,
  formatAgo,
  formatStamp,
  heading,
  isJsonMode,
  kv,
  type KvRow,
  mark,
  safeText,
} from "../lib/out.js";
import { destinationLines } from "../lib/destination-format.js";
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
        w(`${heading(s(key.memo), s(key.id).slice(0, 8))}\n`);
        const stamp = (iso: string) =>
          `${formatStamp(iso)} ${c.dim(`${dot()} ${formatAgo(iso)}`)}`;
        const rows: KvRow[] = [
          ["url", c.link(s(key.url))],
          ["status", key.disabled ? `${mark("none")} ${c.dim("disabled")}` : `${mark("ok")} active`],
          ["created", stamp(key.created_at)],
        ];
        rows.push([
          "notify",
          key.destinations.length > 0
            ? destinationLines(key.destinations)
            : c.dim("none, hits are logged only"),
        ]);
        if (key.expires_at) rows.push(["expires", stamp(key.expires_at)]);
        rows.push(["response", c.dim(s(key.response_kind))]);
        rows.push(["kind", c.dim(s(key.kind))]);
        rows.push(["id", c.dim(`${s(key.id)} ${dot()} public ${s(key.public_id)}`)]);
        if (copied !== null) {
          rows.push([
            "clipboard",
            copied
              ? `${mark("ok")} URL copied`
              : `${mark("warn")} ${c.yellow("no clipboard command available")}`,
          ]);
        }
        w(kv(rows));
        if (qr) w("\n" + qr);
      },
      copied === null ? key : { ...key, copied },
    );
  });
}
