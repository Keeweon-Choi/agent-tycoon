/**
 * Pixel-wise before/after of the same screen: decodes both PNGs in a canvas, counts the pixels whose
 * RGBA differ at all, prints their bounding box and writes the after picture with them in magenta.
 *   npx tsx agent-tycoon/test/desktop-diff.mts <before.png> <after.png> <diff.png>
 */
import { chromium } from '@playwright/test';
import * as fs from 'fs';

const [before, after, out] = process.argv.slice(2);
const b64 = (p: string) => `data:image/png;base64,${fs.readFileSync(p).toString('base64')}`;
const browser = await chromium.launch({ args: ['--disable-gpu'] });
const page = await browser.newPage();
await page.addInitScript('globalThis.__name = (fn) => fn;'); // tsx's helper inside evaluate
await page.goto('about:blank');
const r = await page.evaluate(
  async ([a, b]) => {
    const load = (src: string) =>
      new Promise<HTMLImageElement>((ok) => {
        const i = new Image();
        i.onload = () => ok(i);
        i.src = src;
      });
    const [ia, ib] = await Promise.all([load(a), load(b)]);
    if (ia.width !== ib.width || ia.height !== ib.height) return { size: `${ia.width}x${ia.height} vs ${ib.width}x${ib.height}` };
    const c = document.createElement('canvas');
    c.width = ia.width;
    c.height = ia.height;
    const g = c.getContext('2d')!;
    g.drawImage(ia, 0, 0);
    const da = g.getImageData(0, 0, c.width, c.height).data;
    g.drawImage(ib, 0, 0);
    const img = g.getImageData(0, 0, c.width, c.height);
    const db = img.data;
    let n = 0;
    let [x0, y0, x1, y1] = [c.width, c.height, -1, -1];
    for (let p = 0; p < da.length; p += 4) {
      if (da[p] === db[p] && da[p + 1] === db[p + 1] && da[p + 2] === db[p + 2] && da[p + 3] === db[p + 3]) continue;
      n++;
      const x = (p / 4) % c.width;
      const y = Math.floor(p / 4 / c.width);
      [x0, y0, x1, y1] = [Math.min(x0, x), Math.min(y0, y), Math.max(x1, x), Math.max(y1, y)];
      db.set([255, 0, 255, 255], p);
    }
    g.putImageData(img, 0, 0);
    return { n, total: da.length / 4, box: n ? `${x0},${y0} to ${x1},${y1}` : '', png: c.toDataURL('image/png') };
  },
  [b64(before), b64(after)] as const,
);
await browser.close();
if ('size' in r) throw new Error(`sizes differ: ${r.size}`);
fs.writeFileSync(out, Buffer.from(r.png!.split(',')[1], 'base64'));
console.log(`${after}: ${r.n} of ${r.total} pixels differ${r.n ? ` (box ${r.box})` : ''}`);
