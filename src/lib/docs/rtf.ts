import { type DocOptions, DEFAULT_BODY } from "./util";

/**
 * RTF document with an INCLUDEPICTURE field pointing at the trigger URL.
 *
 * Word resolves `INCLUDEPICTURE` on open and fetches the remote image, so this
 * beacons the same way the .docx does — but RTF is plain text, which makes it
 * the one Office-family bait that survives being opened in a text editor, and
 * WordPad/TextEdit render it without the Protected View banner that .docx
 * inherits from the Mark-of-the-Web.
 *
 * `\\d` means "don't store the image data in the file": the picture is fetched
 * every open rather than cached on first open, so a re-opened document fires
 * again instead of going quiet.
 */
export function generateRtf(opts: DocOptions): Promise<Buffer> {
  const title = rtfEscape(opts.title.replace(/[\r\n]+/g, " "));
  const body = opts.body ?? DEFAULT_BODY;

  const paragraphs = body
    .map((line) => (line ? `\\pard\\sa180 ${rtfEscape(line)}\\par` : "\\par"))
    .join("\n");

  // The field URL is doubly escaped: RTF control-word escaping, then the
  // backslash-doubling INCLUDEPICTURE itself needs for its argument.
  const fieldUrl = rtfEscape(opts.url).replace(/\\/g, "\\\\");

  const rtf = `{\\rtf1\\ansi\\ansicpg1252\\deff0
{\\fonttbl{\\f0\\froman\\fcharset0 Times New Roman;}}
{\\info{\\title ${title}}}
\\viewkind4\\uc1\\pard\\sa200\\sl276\\slmult1\\f0\\fs28\\b ${title}\\b0\\fs22\\par
${paragraphs}
{\\field{\\*\\fldinst{INCLUDEPICTURE "${fieldUrl}" \\\\d}}{\\fldrslt{}}}
}`;

  return Promise.resolve(Buffer.from(rtf, "utf8"));
}

/**
 * RTF is a 7-bit format: the three structural characters must be escaped, and
 * anything outside ASCII has to become a \\uN escape or the reader shows
 * mojibake. An operator memo carrying an em dash or an emoji would otherwise
 * render as garbage in the one place someone is looking closely.
 */
function rtfEscape(s: string): string {
  let out = "";
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    if (ch === "\\" || ch === "{" || ch === "}") {
      out += `\\${ch}`;
    } else if (code < 128) {
      out += ch;
    } else if (code <= 0xffff) {
      // \uN takes a SIGNED 16-bit value; anything above 0x7FFF wraps negative.
      const signed = code > 32767 ? code - 65536 : code;
      out += `\\u${signed}?`;
    } else {
      // Astral plane: emit the surrogate pair, each as its own \uN.
      const v = code - 0x10000;
      const hi = 0xd800 + (v >> 10);
      const lo = 0xdc00 + (v & 0x3ff);
      out += `\\u${hi - 65536}?\\u${lo - 65536}?`;
    }
  }
  return out;
}
