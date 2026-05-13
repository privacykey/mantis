import { xmlEscape, type DocOptions, DEFAULT_BODY } from "./util";

/**
 * Standalone HTML page with `<img>` pointing at the trigger URL.
 *
 * Fires on any browser open. Useful for: web-clip notes (Joplin, Trilium),
 * Nextcloud Files preview, generic file shares, MHTML/HTML archives.
 */
export function generateHtml(opts: DocOptions): Promise<Buffer> {
  const title = xmlEscape(opts.title);
  const url = xmlEscape(opts.url);
  const body = (opts.body ?? DEFAULT_BODY).map(xmlEscape);

  const paragraphs = body
    .map((line) => (line === "" ? "  <p>&nbsp;</p>" : `  <p>${line}</p>`))
    .join("\n");

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${title}</title>
<style>
  body { font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; max-width: 720px; margin: 2rem auto; padding: 0 1rem; color: #111; }
  h1 { font-size: 1.4rem; }
  img.brand { max-width: 100%; height: auto; }
</style>
</head>
<body>
<h1>${title}</h1>
<img class="brand" src="${url}" alt="">
${paragraphs}
<hr>
<p><a href="${url}">${url}</a></p>
</body>
</html>
`;
  return Promise.resolve(Buffer.from(html, "utf8"));
}
