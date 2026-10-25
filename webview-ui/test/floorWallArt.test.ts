/**
 * The drawn floor and wall tiles (cld/scripts/gen-floors-walls.ts) keep the format the
 * engine reads: nine distinct opaque 16x16 grayscale floors with a wide luminance range
 * (Colorize squashes contrast, so a flat pattern vanishes), and a 64x128 wall sheet of
 * 16 pieces (16x32) whose outline sits only where no wall continues (N=1 E=2 S=4 W=8).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PNG } from 'pngjs';
import { test } from 'vitest';

const assets = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public/assets');
const read = (f: string) => PNG.sync.read(fs.readFileSync(path.join(assets, f)));

test('nine distinct opaque grayscale 16x16 floors with a wide luminance range', () => {
  const seen = new Set<string>();
  for (let i = 0; i < 9; i++) {
    const png = read(`floors/floor_${i}.png`);
    assert.equal(png.width, 16);
    assert.equal(png.height, 16);
    let lo = 255;
    let hi = 0;
    for (let p = 0; p < png.data.length; p += 4) {
      const [r, g, b, a] = [png.data[p], png.data[p + 1], png.data[p + 2], png.data[p + 3]];
      assert.ok(r === g && g === b, `floor_${i} is grayscale`);
      assert.equal(a, 255, `floor_${i} is opaque`);
      lo = Math.min(lo, r);
      hi = Math.max(hi, r);
    }
    // floor_0 is the calm plain floor on purpose; the patterned ones must survive squashed contrast
    assert.ok(hi - lo >= (i === 0 ? 20 : 60), `floor_${i} spans ${hi - lo} levels`);
    seen.add(png.data.toString('base64'));
  }
  assert.equal(seen.size, 9, 'the nine patterns differ');
});

test('wall sheet: 16 pieces, outline only where no wall continues', () => {
  const png = read('walls/wall_0.png');
  assert.equal(png.width, 64);
  assert.equal(png.height, 128);
  const px = (m: number, x: number, y: number) => {
    const i = (((m >> 2) * 32 + y) * 64 + (m % 4) * 16 + x) * 4;
    return { v: png.data[i], a: png.data[i + 3] };
  };
  for (let m = 0; m < 16; m++) {
    const [n, e, s, w] = [m & 1, m & 2, m & 4, m & 8];
    // the foot row and the side columns are outline (dark) exactly when nothing continues that way
    assert.equal(px(m, 8, 31).v < 60, !s, `piece ${m}: foot outline`);
    assert.equal(px(m, 8, 0).v < 60, !n, `piece ${m}: top outline`);
    assert.equal(px(m, 15, 16).v < 60, !e, `piece ${m}: east outline`);
    assert.equal(px(m, 0, 16).v < 60, !w, `piece ${m}: west outline`);
    // the middle is always solid
    assert.equal(px(m, 8, 16).a, 255);
  }
});
