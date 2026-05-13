import { xmlEscape, type DocOptions, DEFAULT_BODY } from "./util";

/**
 * RFC 5322 email message (.eml) with multipart/alternative text + HTML body.
 *
 * The HTML body references the trigger URL via `<img src>`. Opening the .eml
 * in any mail client (Thunderbird, Apple Mail, Outlook, mobile clients) fires
 * the canary the moment the client renders HTML.
 *
 * Drop into Paperless email archives, Mailcow junk folders, or any
 * mail-archive workflow that surfaces .eml previews.
 */
export function generateEml(opts: DocOptions): Promise<Buffer> {
  const title = opts.title.replace(/[\r\n]+/g, " ").slice(0, 200);
  const url = opts.url;
  const bodyLines = opts.body ?? DEFAULT_BODY;
  const text = bodyLines.join("\r\n");
  const htmlBody = bodyLines
    .map((line) =>
      line === "" ? "<p>&nbsp;</p>" : `<p>${xmlEscape(line)}</p>`,
    )
    .join("\r\n");

  const date = new Date().toUTCString();
  const boundary = "mantis-boundary-" + Math.random().toString(36).slice(2, 12);
  const messageId = `<${Math.random().toString(36).slice(2)}@mantis.local>`;

  const eml = [
    `From: "Records" <records@example.invalid>`,
    `To: "Recipient" <recipient@example.invalid>`,
    `Subject: ${title}`,
    `Date: ${date}`,
    `Message-ID: ${messageId}`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    ``,
    `--${boundary}`,
    `Content-Type: text/plain; charset="utf-8"`,
    `Content-Transfer-Encoding: 7bit`,
    ``,
    text,
    ``,
    `${url}`,
    ``,
    `--${boundary}`,
    `Content-Type: text/html; charset="utf-8"`,
    `Content-Transfer-Encoding: 7bit`,
    ``,
    `<!doctype html><html><body>`,
    `<h2>${xmlEscape(title)}</h2>`,
    `<p><img src="${xmlEscape(url)}" alt="" width="600" height="1" style="display:block;border:0;"></p>`,
    htmlBody,
    `<hr><p><a href="${xmlEscape(url)}">${xmlEscape(url)}</a></p>`,
    `</body></html>`,
    ``,
    `--${boundary}--`,
    ``,
  ].join("\r\n");

  return Promise.resolve(Buffer.from(eml, "utf8"));
}
