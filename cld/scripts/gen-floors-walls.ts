/**
 * Draw the office's floor and wall tiles into webview-ui/public/assets/:
 * - floors/floor_0..8.png: nine 16x16 grayscale patterns. The webview recolours
 *   them at runtime (Colorize: luminance becomes lightness, see
 *   webview-ui/src/office/colorize.ts), so only the luminance matters; layouts
 *   squash the contrast (c down to -88), hence a wide 90..235 range.
 *   plain, wood planks, square tiles, checker, carpet weave, flagstone,
 *   herringbone (chevron parquet), dots, concrete.
 * - walls/wall_0.png: 64x128, a 4x4 grid of 16x32 auto-tile pieces; piece M
 *   (N=1 E=2 S=4 W=8, set = a wall tile lies that way) is at col M%4, row M>>2.
 *   The piece's lower 16 rows are the tile itself, the upper 16 rise over the
 *   tile above. Rows 0..7 are the wall's top (cap); rows 8..30 the front face
 *   (plaster, chair rail, wainscot, baseboard) unless a wall continues south,
 *   in which case the cap runs the whole piece. Same geometry as the piece set
 *   the engine was written against, so no engine change.
 *
 * Deterministic (seeded noise), no input files, nothing downloaded.
 *
 *   npx tsx cld/scripts/gen-floors-walls.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { PNG } from 'pngjs';

const root = path.resolve(__dirname, '../..');
const assets = path.join(root, 'webview-ui/public/assets');
const T = 16;

/** Small seeded PRNG (mulberry32): the same pixels on every run. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const wrap = (v: number) => ((v % T) + T) % T;
const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));

type Grid = number[][]; // [y][x] luminance, -1 = transparent

function grid(w: number, h: number, v = 0): Grid {
  return Array.from({ length: h }, () => Array<number>(w).fill(v));
}

function toPng(g: Grid): PNG {
  const h = g.length;
  const w = g[0].length;
  const png = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = g[y][x];
      const i = (y * w + x) * 4;
      const a = v < 0 ? 0 : 255;
      const c = v < 0 ? 0 : clamp(v);
      png.data[i] = c;
      png.data[i + 1] = c;
      png.data[i + 2] = c;
      png.data[i + 3] = a;
    }
  }
  return png;
}

/** Add +-amp speckle to every pixel of a grid (kept tileable: it is per pixel). */
function speckle(g: Grid, rand: () => number, amp: number, chance = 1): void {
  for (const row of g) {
    for (let x = 0; x < row.length; x++) {
      if (row[x] >= 0 && rand() < chance) row[x] += Math.round((rand() * 2 - 1) * amp);
    }
  }
}

// ── floors ────────────────────────────────────────────────────

/** 0: plain. A calm polished floor: a faint speckle, nothing that tiles visibly. */
function floorPlain(): Grid {
  const r = rng(101);
  const g = grid(T, T, 178);
  speckle(g, r, 7, 0.5);
  for (let n = 0; n < 6; n++) g[Math.floor(r() * T)][Math.floor(r() * T)] += 14;
  return g;
}

/** 1: wood planks. Four planks high, staggered butt joints, a little grain. */
function floorPlanks(): Grid {
  const r = rng(202);
  const tone = [176, 160, 188, 168];
  const joint = [3, 11, 6, 14];
  const g = grid(T, T);
  for (let p = 0; p < 4; p++) {
    for (let y = 0; y < 3; y++) {
      for (let x = 0; x < T; x++) g[p * 4 + y][x] = tone[p] + (y === 0 ? 16 : y === 2 ? -8 : 0);
    }
    for (let x = 0; x < T; x++) g[p * 4 + 3][x] = 104; // seam under the plank
    for (let y = 0; y < 3; y++) g[p * 4 + y][joint[p]] = 112; // end joint
    for (let n = 0; n < 3; n++) {
      const y = p * 4 + 1 + Math.floor(r() * 2);
      const x0 = Math.floor(r() * T);
      const len = 3 + Math.floor(r() * 4);
      for (let k = 0; k < len; k++) {
        const x = wrap(x0 + k);
        if (x !== joint[p]) g[y][x] -= 16;
      }
    }
  }
  return g;
}

/** 2: square tiles. 2x2 tiles with grout, lit on the top-left edge. */
function floorSquares(): Grid {
  const r = rng(303);
  const tone = [190, 200, 196, 184];
  const g = grid(T, T);
  for (let ty = 0; ty < 2; ty++) {
    for (let tx = 0; tx < 2; tx++) {
      const base = tone[ty * 2 + tx];
      for (let y = 0; y < 8; y++) {
        for (let x = 0; x < 8; x++) {
          let v = base;
          if (x === 7 || y === 7)
            v = 100; // grout
          else if (x === 0 || y === 0)
            v = base + 30; // lit edge
          else if (x === 6 || y === 6) v = base - 16; // shaded edge
          g[ty * 8 + y][tx * 8 + x] = v;
        }
      }
    }
  }
  speckle(g, r, 3, 0.3);
  return g;
}

/** 3: checker. 8px squares, light and dark, each with a lit top row. */
function floorChecker(): Grid {
  const g = grid(T, T);
  for (let y = 0; y < T; y++) {
    for (let x = 0; x < T; x++) {
      const light = ((x >> 3) + (y >> 3)) % 2 === 0;
      let v = light ? 222 : 132;
      if (y % 8 === 0) v += 14;
      if (y % 8 === 7) v -= 14;
      if ((x + y) % 4 === 0) v += light ? -6 : 6; // a hint of grain
      g[y][x] = v;
    }
  }
  return g;
}

/** 4: carpet weave. 4x4 basket-weave cells, alternating strand direction. */
function floorWeave(): Grid {
  const r = rng(505);
  const g = grid(T, T);
  for (let y = 0; y < T; y++) {
    for (let x = 0; x < T; x++) {
      const horiz = ((x >> 2) + (y >> 2)) % 2 === 0;
      const strand = horiz ? y % 2 : x % 2;
      g[y][x] = strand === 0 ? 176 : 146;
      if ((horiz ? x : y) % 4 === 3) g[y][x] -= 22; // strand ends tuck under
    }
  }
  speckle(g, r, 6, 0.35);
  return g;
}

/** 5: flagstone. Seeded cells on a torus (so it tiles), dark mortar between. */
function floorStone(): Grid {
  const r = rng(606);
  const seeds: { x: number; y: number; tone: number }[] = [];
  const cols = 3;
  const rows = 3;
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      seeds.push({
        x: ((i + 0.5) * T) / cols + (r() - 0.5) * 3.2 + (j % 2) * 2.5,
        y: ((j + 0.5) * T) / rows + (r() - 0.5) * 3.2,
        tone: 168 + Math.round(r() * 52),
      });
    }
  }
  const dist = (x: number, y: number, s: { x: number; y: number }) => {
    let dx = Math.abs(x - s.x);
    let dy = Math.abs(y - s.y);
    dx = Math.min(dx, T - dx);
    dy = Math.min(dy, T - dy);
    return Math.hypot(dx * 0.9, dy * 1.15);
  };
  const g = grid(T, T);
  for (let y = 0; y < T; y++) {
    for (let x = 0; x < T; x++) {
      const d = seeds
        .map((s, k) => ({ k, d: dist(x + 0.5, y + 0.5, s) }))
        .sort((a, b) => a.d - b.d);
      const edge = d[1].d - d[0].d;
      if (edge < 1.15) g[y][x] = 96;
      else {
        let v = seeds[d[0].k].tone;
        if (edge < 2.1)
          v -= 18; // a rounded shoulder
        else if (edge > 3.4 && (x + y) % 3 === 0) v += 10;
        g[y][x] = v;
      }
    }
  }
  speckle(g, r, 5, 0.3);
  return g;
}

/** 6: herringbone. Diagonal 4px planks that turn at the middle of the tile, V after V. */
function floorHerringbone(): Grid {
  const r = rng(707);
  const tone = [190, 172, 200, 180];
  const g = grid(T, T);
  for (let y = 0; y < T; y++) {
    for (let x = 0; x < T; x++) {
      const left = x < 8;
      const key = wrap(left ? y + x : y + 15 - x);
      let v = tone[key >> 2] + (left ? 10 : -12);
      if ((key & 3) === 0)
        v = 108; // the long joint
      else if ((key & 3) === 1) v += 12; // lit edge
      if (x === 0 || x === 8) v = Math.min(v, 112); // the turn: one dark column, V after V
      g[y][x] = v;
    }
  }
  speckle(g, r, 4, 0.3);
  return g;
}

/** 7: dots. A darker ground with raised round studs, staggered. */
function floorDots(): Grid {
  const r = rng(808);
  const g = grid(T, T, 138);
  speckle(g, r, 6, 0.5);
  const studs = [
    [2, 2],
    [10, 2],
    [6, 10],
    [14, 10],
  ];
  for (const [sx, sy] of studs) {
    for (let dy = 0; dy < 3; dy++) {
      for (let dx = 0; dx < 3; dx++) {
        if ((dx === 0 || dx === 2) && (dy === 0 || dy === 2)) continue; // round it
        const v = dx === 0 || dy === 0 ? 232 : dx === 2 || dy === 2 ? 168 : 214;
        g[wrap(sy + dy)][wrap(sx + dx)] = v;
      }
    }
    for (let dx = 1; dx < 4; dx++) g[wrap(sy + 3)][wrap(sx + dx)] = 100; // its shadow
    g[wrap(sy + 1)][wrap(sx + 3)] = 100;
  }
  return g;
}

/** 8: concrete. Blotchy value noise, pits, and the slab's joint along its top and left. */
function floorConcrete(): Grid {
  const r = rng(909);
  const cells = grid(4, 4);
  for (const row of cells) for (let x = 0; x < 4; x++) row[x] = Math.round((r() * 2 - 1) * 12);
  const g = grid(T, T);
  for (let y = 0; y < T; y++) {
    for (let x = 0; x < T; x++) {
      // bilinear value noise on a wrapping 4x4 lattice
      const fx = x / 4;
      const fy = y / 4;
      const x0 = Math.floor(fx);
      const y0 = Math.floor(fy);
      const tx = fx - x0;
      const ty = fy - y0;
      const a = cells[y0 % 4][x0 % 4];
      const b = cells[y0 % 4][(x0 + 1) % 4];
      const c = cells[(y0 + 1) % 4][x0 % 4];
      const d = cells[(y0 + 1) % 4][(x0 + 1) % 4];
      g[y][x] = 170 + a * (1 - tx) * (1 - ty) + b * tx * (1 - ty) + c * (1 - tx) * ty + d * tx * ty;
    }
  }
  speckle(g, r, 9, 0.8);
  for (let n = 0; n < 7; n++) {
    const x = 1 + Math.floor(r() * 14);
    const y = 1 + Math.floor(r() * 14);
    g[y][x] = 118;
    if (r() < 0.5) g[y][wrap(x + 1)] = 134;
  }
  for (let i = 0; i < T; i++) {
    g[0][i] = 128; // the slab joint
    g[i][0] = 128;
    g[1][i] += 18;
    if (i > 0) g[i][1] += 18;
  }
  return g;
}

// ── walls ─────────────────────────────────────────────────────

const OUT = 38; // outline
const CAP = 200; // top surface
const CAP_LIT = 232;
const CAP_SHADE = 158;
const PLASTER = 218;
const RAIL_LIT = 244;
const RAIL_SHADE = 160;
const WAINSCOT = 186;
const GROOVE = 142;
const BASE = 122;
const BASE_LIT = 164;

const N = 1;
const E = 2;
const S = 4;
const W = 8;

/** One 16x32 wall piece for a neighbour bitmask. */
function wallPiece(mask: number): Grid {
  const r = rng(1000 + mask);
  const n = (mask & N) !== 0;
  const e = (mask & E) !== 0;
  const s = (mask & S) !== 0;
  const w = (mask & W) !== 0;
  const H = 32;
  const g = grid(T, H);
  const capRows = s ? H : 8;

  // top surface
  for (let y = 0; y < capRows; y++) {
    for (let x = 0; x < T; x++) {
      let v = CAP + ((x * 3 + y * 5) % 7 === 0 ? -6 : 0);
      if (r() < 0.06) v += r() < 0.5 ? 8 : -8;
      g[y][x] = v;
    }
  }
  // the cap's lit and shaded edges (only where the wall ends)
  if (!n) for (let x = 0; x < T; x++) g[1][x] = CAP_LIT;
  if (!w) for (let y = 0; y < capRows; y++) g[y][1] = CAP_LIT;
  if (!e) for (let y = 0; y < capRows; y++) g[y][14] = CAP_SHADE;
  if (!s) for (let x = 0; x < T; x++) g[7][x] = CAP_SHADE;

  // front face: plaster, chair rail, wainscot with grooves, baseboard
  if (!s) {
    for (let y = 8; y < H; y++) {
      for (let x = 0; x < T; x++) {
        let v: number;
        if (y === 8)
          v = RAIL_LIT; // the cap's front edge catches the light
        else if (y < 20) {
          v = PLASTER;
          if (r() < 0.07) v -= 7;
          if (y === 9) v -= 14; // a soft shadow under the cap
        } else if (y === 20)
          v = RAIL_LIT; // chair rail
        else if (y === 21) v = RAIL_SHADE;
        else if (y < 28) {
          v = WAINSCOT;
          if (x === 4 || x === 12)
            v = GROOVE; // panel grooves, 8px apart: tiles with the neighbour
          else if (x === 5 || x === 13) v = WAINSCOT + 22;
          if (y === 22 || y === 27) v -= 10;
        } else if (y === 28)
          v = BASE_LIT; // baseboard
        else v = BASE;
        g[y][x] = v;
      }
    }
    if (!e) for (let y = 9; y < 31; y++) g[y][14] -= 22; // the turned corner is in shade
    if (!w) for (let y = 9; y < 31; y++) g[y][1] += 10;
  }

  // outline: sides where the wall ends, top where nothing is above, foot where nothing is south
  for (let y = 0; y < H; y++) {
    if (!w) g[y][0] = OUT;
    if (!e) g[y][15] = OUT;
  }
  if (!n) for (let x = 0; x < T; x++) g[0][x] = OUT;
  if (!s) for (let x = 0; x < T; x++) g[H - 1][x] = OUT;
  // rounded outer corners
  if (!n && !w) g[0][0] = -1;
  if (!n && !e) g[0][15] = -1;
  if (!s && !w) g[H - 1][0] = -1;
  if (!s && !e) g[H - 1][15] = -1;
  return g;
}

function wallSheet(): Grid {
  const sheet = grid(64, 128);
  for (let mask = 0; mask < 16; mask++) {
    const piece = wallPiece(mask);
    const ox = (mask % 4) * 16;
    const oy = (mask >> 2) * 32;
    for (let y = 0; y < 32; y++) for (let x = 0; x < 16; x++) sheet[oy + y][ox + x] = piece[y][x];
  }
  return sheet;
}

// ── write ─────────────────────────────────────────────────────

const floors = [
  floorPlain,
  floorPlanks,
  floorSquares,
  floorChecker,
  floorWeave,
  floorStone,
  floorHerringbone,
  floorDots,
  floorConcrete,
];
fs.mkdirSync(path.join(assets, 'floors'), { recursive: true });
floors.forEach((draw, i) => {
  fs.writeFileSync(path.join(assets, 'floors', `floor_${i}.png`), PNG.sync.write(toPng(draw())));
});
fs.mkdirSync(path.join(assets, 'walls'), { recursive: true });
fs.writeFileSync(path.join(assets, 'walls', 'wall_0.png'), PNG.sync.write(toPng(wallSheet())));
console.log(`floors: ${floors.length} x ${T}x${T}; walls: 64x128`);
