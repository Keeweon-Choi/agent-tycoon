/**
 * GFX: the owner's title-scene art (owner-ref-1025/lobby-bg/lobby, 10-25) into the webview: a
 * painted, not a pixel-exact image, so it is re-encoded as WebP (quality 0.9, in headless
 * Chromium without a GPU) instead of shipped as a 2.6 MB PNG. (GFX2: the side-view skyline this
 * script also made is gone; the office's backdrop is gen-topdown-backdrop.ts.)
 *
 *   npx tsx cld/scripts/gen-gfx-assets.ts <path to lobby-bg>
 */
import * as fs from 'fs';
import * as path from 'path';
import { chromium } from 'playwright';

import { CHROME } from '../../server/src/cld/testHome.js';

const root = path.resolve(__dirname, '../..');
const OUT = path.join(root, 'webview-ui/src/cld/gfx/art');
const WEBP_QUALITY = 0.9;

async function main() {
  const pack = process.argv[2];
  if (!pack || !fs.existsSync(path.join(pack, 'lobby'))) throw new Error('usage: <lobby-bg>');
  fs.mkdirSync(OUT, { recursive: true });

  const browser = await chromium.launch({ executablePath: CHROME, args: ['--disable-gpu'] });
  try {
    const page = await browser.newPage();
    for (const [name, file] of [
      ['title-wide', 'title_scene_night_no_buttons_1672x941.png'],
      ['title-tall', 'title_scene_alt_1448x1086.png'],
    ]) {
      const b64 = fs.readFileSync(path.join(pack, 'lobby', file)).toString('base64');
      const webp = await page.evaluate(
        async ({ b64, q }) => {
          const img = new Image();
          img.src = `data:image/png;base64,${b64}`;
          await img.decode();
          const c = document.createElement('canvas');
          c.width = img.naturalWidth;
          c.height = img.naturalHeight;
          c.getContext('2d')!.drawImage(img, 0, 0);
          return c.toDataURL('image/webp', q).split(',')[1];
        },
        { b64, q: WEBP_QUALITY },
      );
      fs.writeFileSync(path.join(OUT, `${name}.webp`), Buffer.from(webp, 'base64'));
    }
  } finally {
    await browser.close();
  }
  for (const f of fs.readdirSync(OUT)) console.log(f, fs.statSync(path.join(OUT, f)).size);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
