/**
 * T-0017 before/after examples: each generated test photo (never a real one)
 * beside the character the converter makes from it -- walk, type and read
 * frames in three directions, the 16×16 card portrait, and the palette -- with
 * the six built-ins on top for comparison.
 *
 *   npx tsx cld/test/render-character-examples.ts [out.png] [colours]
 */
import * as fs from 'fs';
import * as path from 'path';
import { PNG } from 'pngjs';

import { convertPhoto } from '../../webview-ui/src/cld/characters/convert.js';
import { PORTRAITS, syntheticPhoto } from '../../webview-ui/test/fixtures/syntheticPhotos.js';

const root = path.resolve(__dirname, '../..');
const out = process.argv[2] ?? path.join(root, 'cld/artifacts/t0017/before-after.png');
const colours = Number(process.argv[3] ?? 8);

interface Img {
  width: number;
  height: number;
  data: ArrayLike<number>;
}
const S = 3; // sprite scale
const ROW = 32 * S + 12;
const BG = [42, 42, 58];
const kinds = Object.keys(PORTRAITS);
const builtins = [0, 1, 2, 3, 4, 5].map((i) =>
  PNG.sync.read(
    fs.readFileSync(path.join(root, `webview-ui/public/assets/characters/char_${i}.png`)),
  ),
);
const width = 96 + 16 + 8 * 16 * S + 16 + 16 * 4 + 16 + 16 * 8;
const height = ROW * (kinds.length + 1) + 8;
const canvas = new PNG({ width, height });
for (let i = 0; i < width * height; i++) canvas.data.set([...BG, 255], i * 4);

/** Copy (sx,sy,w,h) of img to (dx,dy) scaled by s, alpha-blended over the canvas. */
function blit(
  img: Img,
  sx: number,
  sy: number,
  w: number,
  h: number,
  dx: number,
  dy: number,
  s: number,
) {
  for (let y = 0; y < h * s; y++)
    for (let x = 0; x < w * s; x++) {
      const si = ((sy + Math.floor(y / s)) * img.width + sx + Math.floor(x / s)) * 4;
      const a = img.data[si + 3] / 255;
      const di = ((dy + y) * width + dx + x) * 4;
      for (let c = 0; c < 3; c++)
        canvas.data[di + c] = Math.round(img.data[si + c] * a + canvas.data[di + c] * (1 - a));
    }
}
function rect(x: number, y: number, w: number, h: number, rgb: readonly number[]) {
  for (let yy = y; yy < y + h; yy++)
    for (let xx = x; xx < x + w; xx++) canvas.data.set([...rgb, 255], (yy * width + xx) * 4);
}

// Row 0: the built-ins, front walk frame each (the "before": what a character looks like today).
builtins.forEach((b, i) => blit(b, 0, 0, 16, 32, 8 + i * 18 * S, 6, S));
const sheetX = 96 + 16;
kinds.forEach((kind, r) => {
  const y = ROW * (r + 1) + 6;
  const photo = syntheticPhoto(kind, 96);
  blit(photo, 0, 0, 96, 96, 0, y, 1);
  const result = convertPhoto(photo, colours);
  const sheet = { width: 112, height: 96, data: result.sheet };
  // Down walk1..3, type1, read1; right walk1, walk2; up walk1 -- one row.
  const frames: Array<[number, number]> = [
    [0, 0],
    [1, 0],
    [2, 0],
    [3, 0],
    [5, 0],
    [0, 2],
    [1, 2],
  ];
  frames.forEach(([f, dir], k) => blit(sheet, f * 16, dir * 32, 16, 32, sheetX + k * 16 * S, y, S));
  blit(sheet, 0, 32, 16, 32, sheetX + 7 * 16 * S, y, S);
  const mugX = sheetX + 8 * 16 * S + 16;
  blit({ width: 16, height: 16, data: result.mugshot }, 0, 0, 16, 16, mugX, y + 16, 4);
  result.palette.forEach((c, k) =>
    rect(mugX + 16 * 4 + 16 + (k % 8) * 16, y + 16 + Math.floor(k / 8) * 16, 14, 14, c.rgb),
  );
});
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, PNG.sync.write(canvas));
console.log(`${out} (${colours} colours)`);
