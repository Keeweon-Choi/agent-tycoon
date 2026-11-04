/**
 * Draw the editor's carpets into webview-ui/public/assets/carpets/carpet_0..2.png (11-04: our own
 * art replaces the contributed upstream sheets; same names and size, so painted carpets keep
 * their variant and just look new).
 *
 * Format the engine reads (core parseCarpetPng, webview carpetTiles.ts): 64x64, a 4x4 grid of
 * 16x16 marching-squares pieces; piece M is at col M%4, row M>>2, and is centred on a tile
 * corner whose four tiles are NW=1 NE=2 SE=4 SW=8 (set = carpeted). Exactly two grey levels:
 * the darker becomes the carpet's main colour, the lighter its accent (the user picks both);
 * any third level would be dropped. Patterns repeat every 16 px so the pieces tile seamlessly.
 *
 * Each pixel's ring = how many pixels inward from the carpet's outer edge it sits (Chebyshev),
 * the rug stops INSET px short of the carpeted tiles' edge so the floor shows around it.
 *   0 bordered: a light inlay line two pixels in, a sparse dot grid in the field
 *   1 striped:  a light fringe on the edge, horizontal stripes every 4 px
 *   2 diamond:  a dark edge and light inlay line, a diamond lattice in the field
 *
 * Deterministic, no input files, nothing downloaded.
 *
 *   npx tsx cld/scripts/gen-carpets.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { PNG } from 'pngjs';

const root = path.resolve(__dirname, '../..');
const out = path.join(root, 'webview-ui/public/assets/carpets');
const T = 16;
const HALF = T / 2;
const INSET = 1;
const MAIN = 100;
const ACCENT = 196;
const NONE = -1;

/** The four tiles around a piece's corner: [bit, x half (0 west, 1 east), y half (0 north, 1 south)]. */
const QUADS: ReadonlyArray<readonly [number, number, number]> = [
  [1, 0, 0],
  [2, 1, 0],
  [4, 1, 1],
  [8, 0, 1],
];

/** Pixel steps from (x,y) into the quadrant (0 inside it). */
function stepsTo(x: number, y: number, qx: number, qy: number): number {
  const dx = qx === 0 ? Math.max(0, x - (HALF - 1)) : Math.max(0, HALF - x);
  const dy = qy === 0 ? Math.max(0, y - (HALF - 1)) : Math.max(0, HALF - y);
  return Math.max(dx, dy);
}

/** Ring of (x,y) in piece `mask` (1 = outermost rug pixel), or 0 off the rug. */
function ring(mask: number, x: number, y: number): number {
  const own = QUADS.find(([, qx, qy]) => stepsTo(x, y, qx, qy) === 0)!;
  if (!(mask & own[0])) return 0;
  let depth = Number.POSITIVE_INFINITY;
  for (const [bit, qx, qy] of QUADS)
    if (!(mask & bit)) depth = Math.min(depth, stepsTo(x, y, qx, qy));
  return depth - INSET > 0 ? depth - INSET : 0;
}

type Pattern = (k: number, x: number, y: number) => number;

const PATTERNS: Pattern[] = [
  (k, x, y) => (k === 2 || (k > 3 && x % 8 === 4 && y % 8 === 4) ? ACCENT : MAIN),
  (k, _x, y) => (k === 1 || (k > 2 && y % 4 === 1) ? ACCENT : MAIN),
  (k, x, y) => {
    if (k <= 2) return k === 2 ? ACCENT : MAIN;
    return k > 3 && Math.abs((x % 8) - 4) + Math.abs((y % 8) - 4) === 3 ? ACCENT : MAIN;
  },
];

function sheet(pattern: Pattern): PNG {
  const png = new PNG({ width: 4 * T, height: 4 * T });
  for (let m = 0; m < 16; m++) {
    const ox = (m % 4) * T;
    const oy = (m >> 2) * T;
    for (let y = 0; y < T; y++) {
      for (let x = 0; x < T; x++) {
        const k = ring(m, x, y);
        const v = k ? pattern(k, x, y) : NONE;
        const i = ((oy + y) * png.width + ox + x) * 4;
        png.data[i] = png.data[i + 1] = png.data[i + 2] = v < 0 ? 0 : v;
        png.data[i + 3] = v < 0 ? 0 : 255;
      }
    }
  }
  return png;
}

fs.mkdirSync(out, { recursive: true });
PATTERNS.forEach((p, i) => {
  fs.writeFileSync(path.join(out, `carpet_${i}.png`), PNG.sync.write(sheet(p)));
  console.log(`carpet_${i}.png`);
});
