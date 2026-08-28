import { type DocOptions } from "./util";
import { xmlEscape } from "./util";

/**
 * Browser bookmark export in Netscape `bookmarks.html` format — what Chrome,
 * Firefox, Edge and Safari all produce from "export bookmarks".
 *
 * Two ways this fires, which is unusual for a credential-store bait:
 *
 *   1. Someone opens the file in a browser to read it. It is HTML, so the
 *      bookmark's `ICON_URI` is fetched on render.
 *   2. Someone clicks the bait bookmark — an internal VPN portal or admin
 *      console is exactly what an intruder browses a bookmark file for.
 *
 * `ICON_URI` is genuine Netscape-format syntax (browsers normally write a
 * `data:` URI there), so a remote URL in that slot is unremarkable to anyone
 * skimming the file.
 */
export function generateBookmarks(opts: DocOptions): Promise<Buffer> {
  const title = xmlEscape(opts.title.replace(/[\r\n]+/g, " "));
  const url = xmlEscape(opts.url);
  const added = 1_893_456_000; // 2030-01-01, fixed for byte-stable downloads

  const decoys: Array<[string, string]> = [
    ["Jira — Platform board", "https://example.atlassian.net/jira/software/projects/PLAT/boards/12"],
    ["AWS Console — prod", "https://console.aws.amazon.com/console/home?region=us-east-1"],
    ["Grafana — prod overview", "https://grafana.internal.example.com/d/abc123/prod-overview"],
    ["Runbook: incident response", "https://example.atlassian.net/wiki/spaces/OPS/pages/98341/Incident+Response"],
  ];

  const rows = [
    ...decoys.map(
      ([name, href]) =>
        `        <DT><A HREF="${xmlEscape(href)}" ADD_DATE="${added}">${xmlEscape(name)}</A>`,
    ),
    // The bait sits inside the same folder as the real-looking internal links,
    // with the beacon in the icon slot.
    `        <DT><A HREF="${url}" ADD_DATE="${added}" ICON_URI="${url}">${title}</A>`,
  ].join("\n");

  const html = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<!-- This is an automatically generated file.
     It will be read and overwritten.
     DO NOT EDIT! -->
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks</H1>
<DL><p>
    <DT><H3 ADD_DATE="${added}" LAST_MODIFIED="${added}">Bookmarks bar</H3>
    <DL><p>
${rows}
    </DL><p>
</DL><p>
`;

  return Promise.resolve(Buffer.from(html, "utf8"));
}
