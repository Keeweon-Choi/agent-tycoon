/**
 * A contact sheet of the generated floors (raw and colorized with the colours the
 * layouts use) and walls (raw, colorized, and a small room in every auto-tile shape).
 *
 *   npx tsx cld/scripts/preview-floors-walls.ts <out.png>
 */
import * as fs from 'fs';
import * as path from 'path';
import { PNG } from 'pngjs';

import { colorizeSprite } from '../../webview-ui/src/office/colorize.ts';
import type { SpriteData } from '../../webview-ui/src/office/types.ts';

const assets = path.resolve(__dirname, '../../webview-ui/public/assets');
const S = 4;
const hex = (r: number, g: number, b: number, a: number) =>
  `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}${a < 255 ? a.toString(16).padStart(2, '0') : ''}`;
function sprite(png: PNG, ox: number, oy: number, w: number, h: number): SpriteData {
  return Array.from({ length: h }, (_, y) =>
    Array.from({ length: w }, (_, x) => {
      const i = ((oy + y) * png.width + ox + x) * 4;
      return png.data[i + 3] < 2
        ? ''
        : hex(png.data[i], png.data[i + 1], png.data[i + 2], png.data[i + 3]);
    }),
  );
}
const read = (f: string) => PNG.sync.read(fs.readFileSync(path.join(assets, f)));
const floors = Array.from({ length: 9 }, (_, i) => {
  const p = read(`floors/floor_${i}.png`);
  return sprite(p, 0, 0, 16, 16);
});
const wallPng = read('walls/wall_0.png');
const pieces = Array.from({ length: 16 }, (_, m) =>
  sprite(wallPng, (m % 4) * 16, (m >> 2) * 32, 16, 32),
);

const W = 1100;
const H = 1200;
const out = new PNG({ width: W, height: H });
for (let i = 0; i < W * H; i++) out.data.set([34, 34, 56, 255], i * 4);
function draw(sp: SpriteData, x0: number, y0: number, scale = S) {
  sp.forEach((row, y) =>
    row.forEach((c, x) => {
      if (!c) return;
      const rgb = [1, 3, 5].map((k) => parseInt(c.slice(k, k + 2), 16));
      for (let yy = 0; yy < scale; yy++)
        for (let xx = 0; xx < scale; xx++) {
          const px = x0 + x * scale + xx;
          const py = y0 + y * scale + yy;
          if (px >= 0 && py >= 0 && px < W && py < H)
            out.data.set([...rgb, 255], (py * W + px) * 4);
        }
    }),
  );
}
const palettes = [
  null,
  { h: 209, s: 39, b: -25, c: -80 },
  { h: 25, s: 48, b: -43, c: -88 },
  { h: 30, s: 30, b: 10, c: 0 },
  { h: 140, s: 30, b: 0, c: 20 },
];
palettes.forEach((pal, row) =>
  floors.forEach((f, i) => {
    // each tile drawn 2x2 so the repeat is visible
    const sp = pal ? colorizeSprite(f, { ...pal, colorize: true }) : f;
    for (let ty = 0; ty < 2; ty++)
      for (let tx = 0; tx < 2; tx++) draw(sp, 8 + i * 120 + tx * 64, 8 + row * 140 + ty * 64);
  }),
);
// walls: the 16 pieces as a sheet (raw, default colour, a layout colour) ...
const wallTop = 5 * 140 + 8;
const wp = [null, { h: 240, s: 25, b: 0, c: 0 }, { h: 209, s: 39, b: -25, c: -80 }];
const tint = (pc: SpriteData, pal: (typeof wp)[number]) =>
  pal ? colorizeSprite(pc, { ...pal, colorize: true }) : pc;
wp.forEach((pal, k) =>
  pieces.forEach((pc, m) =>
    draw(tint(pc, pal), 8 + k * 230 + (m % 4) * 54, wallTop + (m >> 2) * 104, 3),
  ),
);
// ... and a small room built by the engine's rule (N=1 E=2 S=4 W=8), every shape in it.
const map = [
  '#########..#.',
  '#.......#..#.',
  '#.......####.',
  '#.......#....',
  '####.####.##.',
  '.....#....##.',
];
const isWall = (c: number, r: number) => map[r]?.[c] === '#';
for (let r = 0; r < map.length; r++)
  for (let c = 0; c < map[0].length; c++) {
    const wall = isWall(c, r);
    const mask =
      (isWall(c, r - 1) ? 1 : 0) |
      (isWall(c + 1, r) ? 2 : 0) |
      (isWall(c, r + 1) ? 4 : 0) |
      (isWall(c - 1, r) ? 8 : 0);
    const x = 700 + c * 48;
    const y = wallTop + 40 + r * 48;
    if (!wall)
      draw(colorizeSprite(floors[1], { h: 30, s: 30, b: 0, c: 0, colorize: true }), x, y, 3);
    else draw(tint(pieces[mask], wp[2]), x, y - 48, 3);
  }
fs.writeFileSync(process.argv[2], PNG.sync.write(out));
