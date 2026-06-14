import { type DocOptions } from "./util";

/**
 * vCard 4.0 contact with PHOTO;VALUE=URI pointing at the trigger URL.
 *
 * CardDAV clients (macOS Contacts, iOS Contacts, Nextcloud Contacts,
 * Thunderbird Address Book) typically fetch the photo URL on contact render.
 * Import the .vcf into the address book to plant the canary.
 *
 * The trigger URL is also surfaced as a URL property so anyone viewing the
 * contact in source form sees the bait link.
 */
export function generateVcf(opts: DocOptions): Promise<Buffer> {
  const name = vcfEscape(opts.title);
  const url = opts.url;
  const note = vcfEscape(opts.body?.join("\\n") ?? opts.title);

  const vcf = [
    "BEGIN:VCARD",
    "VERSION:4.0",
    `FN:${name}`,
    `N:${name};;;;`,
    `PHOTO;VALUE=URI:${url}`,
    `URL:${url}`,
    `NOTE:${note}`,
    "END:VCARD",
    "",
  ].join("\r\n");

  return Promise.resolve(Buffer.from(vcf, "utf8"));
}

function vcfEscape(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    // Normalize ALL line breaks — CRLF, lone LF, and lone CR. A bare \r (not
    // followed by \n) would otherwise survive and, in line-oriented vCard, let
    // the memo break out of the property value and inject a property line.
    .replace(/\r\n|\r|\n/g, "\\n");
}
