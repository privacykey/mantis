import { randomBytes } from "node:crypto";
import { type DocOptions } from "./util";

/**
 * iCalendar .ics event with ATTACH;FMTTYPE=image/png pointing at the trigger URL.
 *
 * Many calendar clients fetch attachment thumbnails on render. Drop into
 * Radicale, Nextcloud Calendar, Apple Calendar, Outlook, etc. The URL is also
 * mirrored in the URL property so the event itself links to the canary.
 *
 * Event scheduled at 12:00 UTC today; long-lived (no expiry) so it stays
 * findable in the calendar UI.
 */
export function generateIcs(opts: DocOptions): Promise<Buffer> {
  const title = icsEscape(opts.title);
  // Line-safe the URL too: a \r/\n or special char in the operator/key URL
  // would otherwise break out of the URL/ATTACH property value and inject a
  // property line, the same way an unescaped memo could.
  const url = icsEscape(opts.url);
  const description = icsEscape(opts.body?.join("\\n") ?? opts.title);
  // Crypto-grade random UID. Predictable UIDs would let a target who
  // received this canary correlate it with other canaries (same generator,
  // same Math.random seed-derived prefix) — so we use the OS RNG instead.
  const uid = `${randomBytes(12).toString("hex")}-${Date.now()}@mantis.local`;
  const now = formatIcsDate(new Date());
  const start = formatIcsDate(midnightToday(12));
  const end = formatIcsDate(midnightToday(13));

  const ics = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Mantis//Canary//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTAMP:${now}`,
    `DTSTART:${start}`,
    `DTEND:${end}`,
    `SUMMARY:${title}`,
    `DESCRIPTION:${description}`,
    `URL:${url}`,
    `ATTACH;FMTTYPE=image/png:${url}`,
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ].join("\r\n");

  return Promise.resolve(Buffer.from(ics, "utf8"));
}

function icsEscape(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    // Normalize ALL line breaks — CRLF, lone LF, and lone CR. A bare \r (not
    // followed by \n) would otherwise survive and, in line-oriented ICS, let
    // the memo break out of the property value and inject a property line.
    .replace(/\r\n|\r|\n/g, "\\n");
}

function formatIcsDate(d: Date): string {
  return (
    d.getUTCFullYear().toString().padStart(4, "0") +
    (d.getUTCMonth() + 1).toString().padStart(2, "0") +
    d.getUTCDate().toString().padStart(2, "0") +
    "T" +
    d.getUTCHours().toString().padStart(2, "0") +
    d.getUTCMinutes().toString().padStart(2, "0") +
    d.getUTCSeconds().toString().padStart(2, "0") +
    "Z"
  );
}

function midnightToday(hourUtc: number): Date {
  const d = new Date();
  d.setUTCHours(hourUtc, 0, 0, 0);
  return d;
}
