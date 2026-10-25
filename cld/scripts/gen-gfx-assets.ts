/**
 * GFX: the owner's backdrop and title-scene art (owner-ref-1025/lobby-bg, 10-25) into the webview.
 *
 * - The night skyline (main_office/night): every layer is drawn in 2x2 blocks, so it is shrunk to
 *   its true 800x450 pixels (one sample per block; checked: no edge falls on an odd row or
 *   column). The sky layer's lower half came out of the generator nearly transparent (alpha
 *   15-31 over the right colours), which shows as white boxes between the far towers in the
 *   pack's own composite: its alpha is made opaque. city.png is the layers composited again
 *   (the static backdrop); the four layers stay for the optional parallax.
 * - The title scene (lobby/): a painted, not a pixel-exact image, so it is re-encoded as WebP
 *   (quality 0.9, in headless Chromium without a GPU) instead of shipped as a 2.6 MB PNG.
 *
 *   npx tsx cld/scripts/gen-gfx-assets.ts <path to lobby-bg>
 */
import * as fs from 'fs';
import * as path from 'path';
import { chromium } from 'playwright';
import { PNG } from 'pngjs';

import { CHROME } from '../../server/src/cld/testHome.js';

const root = path.resolve(__dirname, '../..');
const OUT = path.join(root, 'webview-ui/src/cld/gfx/art');
const LAYERS = [
  ['sky', '01_sky_1600x900.png'],
  ['far', '02_city_far_1600x900.png'],
  ['mid', '03_city_mid_1600x900.png'],
  ['facade', '04_facade_foreground_1600x900.png'],
] as const;
const BLOCK = 2;
const WEBP_QUALITY = 0.9;

function halve(src: PNG, opaque: boolean): PNG {
  const w = src.width / BLOCK;
  const h = src.height / BLOCK;
  const out = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const s = (y * BLOCK * src.width + x * BLOCK) * 4;
      const d = (y * w + x) * 4;
      src.data.copy(out.data, d, s, s + 4);
      if (opaque) out.data[d + 3] = 255;
    }
  return out;
}

/** `top` over `base` (straight alpha), in place. */
function over(base: PNG, top: PNG): void {
  for (let i = 0; i < base.data.length; i += 4) {
    const a = top.data[i + 3] / 255;
    if (!a) continue;
    for (let k = 0; k < 3; k++)
      base.data[i + k] = Math.round(top.data[i + k] * a + base.data[i + k] * (1 - a));
    base.data[i + 3] = 255;
  }
}

async function main() {
  const pack = process.argv[2];
  if (!pack || !fs.existsSync(path.join(pack, 'main_office'))) throw new Error('usage: <lobby-bg>');
  fs.mkdirSync(OUT, { recursive: true });
  const night = path.join(pack, 'main_office/night/layers');
  const layers = LAYERS.map(([name, file]) => {
    const png = halve(PNG.sync.read(fs.readFileSync(path.join(night, file))), name === 'sky');
    fs.writeFileSync(path.join(OUT, `night-${name}.png`), PNG.sync.write(png));
    return png;
  });
  const city = new PNG({ width: layers[0].width, height: layers[0].height });
  layers[0].data.copy(city.data);
  for (const l of layers.slice(1)) over(city, l);
  fs.writeFileSync(path.join(OUT, 'night-city.png'), PNG.sync.write(city));

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
