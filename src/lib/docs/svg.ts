import { xmlEscape, type DocOptions } from "./util";

/**
 * SVG with `<image href>` pointing at the trigger URL.
 *
 * Browsers and many image viewers fetch external resources from SVG. Drop this
 * into a photo library (Immich/PhotoPrism/Lychee), a notes app, or anywhere
 * SVG renders inline.
 *
 * Note: some apps raster-thumbnail SVGs server-side. In those cases the
 * thumbnail may not fire, but opening the original always does.
 */
export function generateSvg(opts: DocOptions): Promise<Buffer> {
  const title = xmlEscape(opts.title);
  const url = xmlEscape(opts.url);

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 800 600" width="800" height="600">
  <title>${title}</title>
  <rect width="800" height="600" fill="#f3f4f6"/>
  <image href="${url}" xlink:href="${url}" x="0" y="0" width="800" height="600" preserveAspectRatio="xMidYMid slice"/>
  <text x="400" y="580" font-family="sans-serif" font-size="14" fill="#9ca3af" text-anchor="middle">${title}</text>
</svg>
`;
  return Promise.resolve(Buffer.from(svg, "utf8"));
}
