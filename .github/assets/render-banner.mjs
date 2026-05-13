// One-shot rasterizer: .github/assets/banner.svg -> banner.png at 2x display width.
// Run from repo root: `node .github/assets/render-banner.mjs`
import { createRequire } from 'node:module';
const sharp = createRequire(import.meta.url)(
  new URL('../../node_modules/.pnpm/sharp@0.34.5/node_modules/sharp/lib/index.js', import.meta.url).pathname,
);
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const svg = await readFile(join(here, 'banner.svg'));

// Banner SVG viewBox is 800x180; render at 2x = 1600x360 for retina.
const png = await sharp(svg, { density: 192 })
  .resize({ width: 1600 })
  .png({ compressionLevel: 9 })
  .toBuffer();

await writeFile(join(here, 'banner.png'), png);
const meta = await sharp(png).metadata();
console.log(`wrote banner.png ${meta.width}x${meta.height} (${png.length} bytes)`);
