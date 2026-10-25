/**
 * GFX2 (owner 10-25 22:27): the backdrop seen from above, like the office. The owner's scene of
 * the office floors from above with the night city around (downloads2, 07_30_25-2) is snapped to
 * its true pixels with the repo's assetSnap (its generator drew 6.6 px blocks), and its interior
 * (the floors, never shown: our own office stands there) is roofed over in the scene's own roof
 * colour and rooftop. What is left is the surroundings: the tower on the left, the street with trees and
 * lamps and the far city on the right, the rooftops below. The office (fills the roofed hole)
 * is drawn over it; the hole's place is written next to the picture for the renderer.
 *
 *   npx tsx cld/scripts/gen-topdown-backdrop.ts <the 07_30_25-2 png>
 */
import * as fs from 'fs';
import * as path from 'path';
import { PNG } from 'pngjs';

import { findGrid, sampleCells } from '../../server/src/cld/assetSnap.js';

const root = path.resolve(__dirname, '../..');
const ART = path.join(root, 'webview-ui/src/cld/gfx/art');
/** The scene's interior in true px (measured on the snapped picture): the floors and their walls,
 *  and the lounge below them on the left. */
const HOLE: Array<[x0: number, y0: number, x1: number, y1: number]> = [
  [15, 0, 166, 106],
  [15, 106, 58, 138],
];
/** Where the roof colour is sampled (the rooftop below the floors), and its parapet. */
const ROOF_SAMPLE = [70, 128, 160, 140] as const;
/** The rooftop below the floors (AC units, vents): tiled over the hole, so the copies of the
 *  picture around the office (it repeats) show roofs, not a blank square. */
const ROOF_PATCH = [62, 122, 166, 148] as const;

const file = process.argv[2];
if (!file) throw new Error('usage: <07_30_25-2.png>');
const src = PNG.sync.read(fs.readFileSync(file));
const img = { width: src.width, height: src.height, data: new Uint8Array(src.data) };
const grid = findGrid(img);
const cells = sampleCells(img, grid);
const { cols: w, rows: h, data } = cells;

// The commonest colour of the rooftop sample: the roof; a step lighter: its parapet.
const counts = new Map<number, number>();
for (let y = ROOF_SAMPLE[1]; y < ROOF_SAMPLE[3]; y++)
  for (let x = ROOF_SAMPLE[0]; x < ROOF_SAMPLE[2]; x++) {
    const i = (y * w + x) * 4;
    const key = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
const roof = [...counts].sort((a, b) => b[1] - a[1])[0][0];
const rgb = (c: number) => [c >> 16, (c >> 8) & 255, c & 255];
const [rr, rg, rb] = rgb(roof);
const edge = [rr + 14, rg + 14, rb + 20].map((v) => Math.min(255, v));
const inHole = (x: number, y: number) =>
  HOLE.some(([x0, y0, x1, y1]) => x >= x0 && x < x1 && y >= y0 && y < y1);
const patch = data.slice(); // the rooftop as it was, before the hole is filled
const [px0, py0, px1, py1] = ROOF_PATCH;
for (let y = 0; y < h; y++)
  for (let x = 0; x < w; x++) {
    if (!inHole(x, y)) continue;
    const rim = !inHole(x - 1, y) || !inHole(x + 1, y) || !inHole(x, y - 1) || !inHole(x, y + 1);
    const i = (y * w + x) * 4;
    if (rim) {
      [data[i], data[i + 1], data[i + 2]] = edge;
    } else {
      const sx = px0 + (x % (px1 - px0));
      const sy = py0 + (y % (py1 - py0));
      const j = (sy * w + sx) * 4;
      data[i] = patch[j];
      data[i + 1] = patch[j + 1];
      data[i + 2] = patch[j + 2];
    }
    data[i + 3] = 255;
  }
// The picture repeats around the office, and its edges do not meet (a tower cut off on one side,
// a street on the other): the tile is the picture and its mirror images, 2 x 2, so every edge
// meets its own reflection and no seam shows. The hole stays in the top-left copy.
const out = new PNG({ width: 2 * w, height: 2 * h });
for (let y = 0; y < 2 * h; y++)
  for (let x = 0; x < 2 * w; x++) {
    const sx = x < w ? x : 2 * w - 1 - x;
    const sy = y < h ? y : 2 * h - 1 - y;
    for (let c = 0; c < 4; c++) out.data[(y * 2 * w + x) * 4 + c] = data[(sy * w + sx) * 4 + c];
  }
fs.writeFileSync(path.join(ART, 'topdown-night.png'), PNG.sync.write(out));
const hole = HOLE[0];
fs.writeFileSync(
  path.join(ART, 'topdown-night.json'),
  JSON.stringify({
    w: 2 * w,
    h: 2 * h,
    /** The roofed hole's centre (true px): it goes under the floor shown. */
    holeX: (hole[0] + hole[2]) / 2,
    holeY: (hole[1] + hole[3]) / 2,
    fill: `#${roof.toString(16).padStart(6, '0')}`,
    grid: [Number(grid.x.size.toFixed(2)), Number(grid.y.size.toFixed(2))],
  }) + '\n',
);
console.log(
  `${w}x${h} true px (blocks ${grid.x.size.toFixed(2)} x ${grid.y.size.toFixed(2)}), roof #${roof.toString(16)}`,
);
