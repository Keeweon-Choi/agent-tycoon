/**
 * ISO-PILOT art: the isometric pieces the pilot building is drawn with, into
 * webview-ui/src/cld/iso/art/ (one PNG per piece and density) and its manifest.json.
 *
 * Pilot assets, not finished art. The furniture, walls and floors are cut from the owner's
 * isometric starter pack (owner 10-26: `starter-furniture.png`, `starter-structure.png`, solid
 * magenta backgrounds), one object per file:
 *  - the magenta and its pink halo removed (a real transparent background);
 *  - snapped to the art's own pixel grid (its pitch measured per object, about 4 sheet px):
 *    every art pixel becomes one pixel, the block's most central colour;
 *  - scaled (nearest, so pixels stay hard) to the in-game size its footprint asks for, at
 *    density 4: a 16 px world tile is a 64×32 source diamond, the density of the 64×128 HD
 *    characters, so furniture and characters match pixel for pixel at zoom 4; copies at
 *    densities 2 and 1 (`name@2.png`, `name@1.png`) are made by majority over 2×2 blocks for
 *    the zooms those divide;
 *  - the footprint, the anchor (the pixel at the footprint's front corner on the floor) and
 *    which way it faces go in the manifest; the owner's own art replaces a piece by replacing
 *    its PNGs (and the entry, if the size changes), no code.
 * Each cut is checked (report.json): alignment error against the tile diamond in px, magenta
 * or halo pixels left, opaque pixels touching the cut's edge. A review sheet is assembled from
 * the individual files (cld/artifacts/iso-pilot/review-sheet.png).
 *
 * The pack has no floor plate, slab, pavement, glass shaft or elevator car, and no cut-away
 * wall: those few structural pieces are drawn here, in the pack's own colours.
 *
 *   npx tsx cld/scripts/gen-iso-art.ts [--src <dir with the two starter PNGs>]
 */
/* eslint-disable pixel-agents/no-inline-colors -- an asset generator: its palette is pixel data, not UI styling */
import * as fs from 'fs';
import * as path from 'path';
import { PNG } from 'pngjs';

const ROOT = path.resolve(__dirname, '../..');
const OUT = path.join(ROOT, 'webview-ui/src/cld/iso/art');
const SHEET_OUT = path.join(ROOT, 'cld/artifacts/iso-pilot');
const srcArg = process.argv.indexOf('--src');
const SRC =
  srcArg > 0 ? process.argv[srcArg + 1] : path.resolve(ROOT, '../specs/owner-ref-1026-iso');

/** Source px per world px. */
const D = 4;
/** Half a tile diamond in source px (ISO_HALF_W, ISO_HALF_H × D). */
const HW = 8 * D;
const HH = 4 * D;

type Rgba = [number, number, number, number];
const hex = (h: string): Rgba => [
  parseInt(h.slice(1, 3), 16),
  parseInt(h.slice(3, 5), 16),
  parseInt(h.slice(5, 7), 16),
  255,
];
const mix = (a: Rgba, b: Rgba, t: number): Rgba => [
  Math.round(a[0] + (b[0] - a[0]) * t),
  Math.round(a[1] + (b[1] - a[1]) * t),
  Math.round(a[2] + (b[2] - a[2]) * t),
  255,
];
const INK = hex('#1b1824');

// ── Images ───────────────────────────────────────────────────

class Img {
  readonly data: Uint8Array;
  constructor(
    readonly w: number,
    readonly h: number,
  ) {
    this.data = new Uint8Array(w * h * 4);
  }
  static read(file: string): Img {
    const p = PNG.sync.read(fs.readFileSync(file));
    const img = new Img(p.width, p.height);
    img.data.set(p.data);
    return img;
  }
  set(x: number, y: number, c: Rgba): void {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    this.data.set(c, (y * this.w + x) * 4);
  }
  get(x: number, y: number): Rgba | null {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return null;
    const i = (y * this.w + x) * 4;
    return this.data[i + 3] ? [this.data[i], this.data[i + 1], this.data[i + 2], 255] : null;
  }
  write(file: string): void {
    const png = new PNG({ width: this.w, height: this.h });
    png.data.set(this.data);
    fs.writeFileSync(file, PNG.sync.write(png));
  }
  /** Columns x0..x1-1, rows y0..y1-1. */
  crop(x0: number, y0: number, x1: number, y1: number): Img {
    const out = new Img(x1 - x0, y1 - y0);
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++) {
        const c = this.get(x, y);
        if (c) out.set(x - x0, y - y0, c);
      }
    return out;
  }
  /** The bounds of the opaque pixels. */
  bounds(): { x0: number; y0: number; x1: number; y1: number } {
    let [x0, y0, x1, y1] = [this.w, this.h, 0, 0];
    for (let y = 0; y < this.h; y++)
      for (let x = 0; x < this.w; x++)
        if (this.get(x, y))
          [x0, y0, x1, y1] = [
            Math.min(x0, x),
            Math.min(y0, y),
            Math.max(x1, x + 1),
            Math.max(y1, y + 1),
          ];
    return { x0, y0, x1, y1 };
  }
  trim(): Img {
    const b = this.bounds();
    return this.crop(b.x0, b.y0, b.x1, b.y1);
  }
}

/** How magenta a colour is (the background is about #FF00FF, its halo a pink blend). */
const magenta = (r: number, g: number, b: number) => Math.min(r, b) - g;
const BG = 90;
const HALO = 34;

// ── Cutting objects out of a sheet ───────────────────────────

/** The object in a box of a sheet: its pixels, the background and its halo removed. */
function cutObject(sheet: Img, box: [number, number, number, number]): { img: Img; halo: number } {
  const [x0, y0, x1, y1] = box;
  const pad = 2;
  const img = new Img(x1 - x0 + 1 + 2 * pad, y1 - y0 + 1 + 2 * pad);
  for (let y = y0 - pad; y <= y1 + pad; y++)
    for (let x = x0 - pad; x <= x1 + pad; x++) {
      const c = sheet.get(x, y);
      if (!c || magenta(c[0], c[1], c[2]) > BG) continue;
      img.set(x - x0 + pad, y - y0 + pad, c);
    }
  // Only the largest connected piece (a neighbour's edge never comes along), its parts
  // joined across small gaps (a chair's wheels).
  keepLargest(img, 6);
  // The halo: pinkish pixels within two pixels of the background.
  let halo = 0;
  for (let pass = 0; pass < 2; pass++) {
    const drop: Array<[number, number]> = [];
    for (let y = 0; y < img.h; y++)
      for (let x = 0; x < img.w; x++) {
        const c = img.get(x, y);
        if (!c || magenta(c[0], c[1], c[2]) <= HALO) continue;
        if (!img.get(x - 1, y) || !img.get(x + 1, y) || !img.get(x, y - 1) || !img.get(x, y + 1))
          drop.push([x, y]);
      }
    for (const [x, y] of drop) img.data.fill(0, (y * img.w + x) * 4, (y * img.w + x) * 4 + 4);
    halo += drop.length;
  }
  return { img: img.trim(), halo };
}

function keepLargest(img: Img, join: number): void {
  const n = img.w * img.h;
  const lab = new Int32Array(n);
  let best = 0;
  let bestSize = 0;
  let k = 0;
  for (let i = 0; i < n; i++) {
    if (!img.data[i * 4 + 3] || lab[i]) continue;
    k++;
    let size = 0;
    const stack = [i];
    lab[i] = k;
    while (stack.length) {
      const j = stack.pop()!;
      size++;
      const x = j % img.w;
      const y = (j / img.w) | 0;
      for (let dy = -join; dy <= join; dy++)
        for (let dx = -join; dx <= join; dx++) {
          const X = x + dx;
          const Y = y + dy;
          if (X < 0 || Y < 0 || X >= img.w || Y >= img.h) continue;
          const m = Y * img.w + X;
          if (img.data[m * 4 + 3] && !lab[m]) {
            lab[m] = k;
            stack.push(m);
          }
        }
    }
    if (size > bestSize) [best, bestSize] = [k, size];
  }
  for (let i = 0; i < n; i++) if (lab[i] !== best) img.data.fill(0, i * 4, i * 4 + 4);
}

/** The art's pixel pitch (sheet px per art px), from where its colours change along x. */
function pitch(img: Img): number {
  const score = (p: number) => {
    let re = 0;
    let im = 0;
    let tot = 0;
    for (let y = 0; y < img.h; y++)
      for (let x = 0; x + 1 < img.w; x++) {
        const a = img.get(x, y);
        const b = img.get(x + 1, y);
        if (!a || !b) continue;
        const v = Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
        const t = (2 * Math.PI * (x + 1)) / p;
        re += v * Math.cos(t);
        im += v * Math.sin(t);
        tot += v;
      }
    return tot ? Math.hypot(re, im) / tot : 0;
  };
  let best = 4;
  let bestScore = -1;
  for (let p = 3.5; p <= 4.5; p += 0.02) {
    const s = score(p);
    if (s > bestScore) [best, bestScore] = [p, s];
  }
  return best;
}

function block(img: Img, x: number, y: number, p: number): Rgba[] {
  const out: Rgba[] = [];
  for (let yy = Math.round(y); yy < Math.round(y + p); yy++)
    for (let xx = Math.round(x); xx < Math.round(x + p); xx++) {
      const c = img.get(xx, yy);
      if (c) out.push(c);
    }
  return out;
}

function medoid(cs: Rgba[]): Rgba {
  let best = cs[0];
  let bestD = Infinity;
  for (const a of cs) {
    let d = 0;
    for (const b of cs) d += Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
    if (d < bestD) [best, bestD] = [a, d];
  }
  return best;
}

/** The art at its own pixels: each block of `p` sheet px becomes the block's most central
 *  colour (the medoid), opaque when most of the block is; at the phase that makes the blocks
 *  most uniform. */
function snap(img: Img, p: number): Img {
  let bestPhase: [number, number] = [0, 0];
  let bestErr = Infinity;
  for (let ox = 0; ox < p; ox += 0.5)
    for (let oy = 0; oy < p; oy += 0.5) {
      let err = 0;
      for (let y = oy; y < img.h; y += p * 3)
        for (let x = ox; x < img.w; x += p * 3) {
          const cs = block(img, x, y, p);
          if (cs.length < 2) continue;
          const m = cs
            .reduce((a, c) => [a[0] + c[0], a[1] + c[1], a[2] + c[2]], [0, 0, 0])
            .map((v) => v / cs.length);
          for (const c of cs)
            err += Math.abs(c[0] - m[0]) + Math.abs(c[1] - m[1]) + Math.abs(c[2] - m[2]);
        }
      if (err < bestErr) [bestErr, bestPhase] = [err, [ox, oy]];
    }
  const [ox, oy] = bestPhase;
  const w = Math.ceil((img.w - ox) / p) + 1;
  const h = Math.ceil((img.h - oy) / p) + 1;
  const out = new Img(w, h);
  const area = Math.round(p) * Math.round(p);
  for (let j = 0; j < h; j++)
    for (let i = 0; i < w; i++) {
      const cs = block(img, ox + (i - 1) * p, oy + (j - 1) * p, p);
      if (cs.length * 2 >= area) out.set(i, j, medoid(cs));
    }
  return out.trim();
}

/** Scale by `f`: nearest when it grows (hard pixels), the block medoid when it shrinks. */
function scale(img: Img, f: number): Img {
  const w = Math.max(1, Math.round(img.w * f));
  const h = Math.max(1, Math.round(img.h * f));
  const out = new Img(w, h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if (f >= 1) {
        const c = img.get(Math.floor((x + 0.5) / f), Math.floor((y + 0.5) / f));
        if (c) out.set(x, y, c);
        continue;
      }
      const cs: Rgba[] = [];
      let n = 0;
      for (let yy = Math.floor(y / f); yy < Math.floor((y + 1) / f); yy++)
        for (let xx = Math.floor(x / f); xx < Math.floor((x + 1) / f); xx++) {
          n++;
          const c = img.get(xx, yy);
          if (c) cs.push(c);
        }
      if (cs.length && cs.length * 2 >= n) out.set(x, y, medoid(cs));
    }
  return out;
}

/** A copy at a coarser density: `k`×`k` blocks aligned on the anchor (the footprint's corner
 *  stays on a block edge), majority alpha, medoid colour. */
function lod(
  img: Img,
  k: number,
  anchor: [number, number],
): { img: Img; anchor: [number, number] } {
  const sx = -(((-anchor[0] % k) + k) % k);
  const sy = -(((-anchor[1] % k) + k) % k);
  const w = Math.ceil((img.w - sx) / k);
  const h = Math.ceil((img.h - sy) / k);
  const out = new Img(w, h);
  for (let j = 0; j < h; j++)
    for (let i = 0; i < w; i++) {
      const cs: Rgba[] = [];
      for (let y = 0; y < k; y++)
        for (let x = 0; x < k; x++) {
          const c = img.get(sx + i * k + x, sy + j * k + y);
          if (c) cs.push(c);
        }
      if (cs.length * 2 > k * k) out.set(i, j, medoid(cs));
    }
  return { img: out, anchor: [(anchor[0] - sx) / k, (anchor[1] - sy) / k] };
}

// ── Drawing (the structural pieces) ──────────────────────────

type Pt = [number, number];

/** Fill a polygon by pixel centres (2:1 edges through lattice points never touch a centre). */
function poly(img: Img, pts: Pt[], c: Rgba): void {
  const ys = pts.map((p) => p[1]);
  for (let y = Math.floor(Math.min(...ys)); y <= Math.ceil(Math.max(...ys)); y++) {
    const cy = y + 0.5;
    const xs: number[] = [];
    for (let i = 0; i < pts.length; i++) {
      const [x0, y0] = pts[i];
      const [x1, y1] = pts[(i + 1) % pts.length];
      if ((y0 <= cy && y1 > cy) || (y1 <= cy && y0 > cy))
        xs.push(x0 + ((cy - y0) / (y1 - y0)) * (x1 - x0));
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2)
      for (let x = Math.ceil(xs[k] - 0.5); x + 0.5 < xs[k + 1]; x++) img.set(x, y, c);
  }
}

/** A footprint fw×fh with `top` source px of height (`below` under the floor). (u, v, z):
 *  tiles along the columns and rows from its back corner, world px up. */
class Frame {
  readonly img: Img;
  readonly ox: number;
  readonly oy: number;
  constructor(
    readonly fw: number,
    readonly fh: number,
    readonly top: number,
    readonly below = 0,
  ) {
    this.img = new Img((fw + fh) * HW, (fw + fh) * HH + top + below);
    this.ox = fh * HW;
    this.oy = top;
  }
  p(u: number, v: number, z: number): Pt {
    return [this.ox + (u - v) * HW, this.oy + (u + v) * HH - z * D];
  }
  face(u0: number, v0: number, u1: number, v1: number, z: number, c: Rgba): void {
    poly(this.img, [this.p(u0, v0, z), this.p(u1, v0, z), this.p(u1, v1, z), this.p(u0, v1, z)], c);
  }
  row(u0: number, u1: number, v: number, z0: number, z1: number, c: Rgba): void {
    poly(this.img, [this.p(u0, v, z0), this.p(u1, v, z0), this.p(u1, v, z1), this.p(u0, v, z1)], c);
  }
  col(u: number, v0: number, v1: number, z0: number, z1: number, c: Rgba): void {
    poly(this.img, [this.p(u, v0, z0), this.p(u, v1, z0), this.p(u, v1, z1), this.p(u, v0, z1)], c);
  }
  box(
    u0: number,
    v0: number,
    u1: number,
    v1: number,
    z0: number,
    z1: number,
    c: { top: Rgba; lit: Rgba; shade: Rgba },
  ): void {
    this.row(u0, u1, v1, z0, z1, c.lit);
    this.col(u1, v0, v1, z0, z1, c.shade);
    this.face(u0, v0, u1, v1, z1, c.top);
  }
}

/** A 1 px darker edge around the silhouette. */
function outline(img: Img, amount = 0.6): void {
  const edge: Array<[number, number, Rgba]> = [];
  for (let y = 0; y < img.h; y++)
    for (let x = 0; x < img.w; x++) {
      const c = img.get(x, y);
      if (
        c &&
        (!img.get(x - 1, y) || !img.get(x + 1, y) || !img.get(x, y - 1) || !img.get(x, y + 1))
      )
        edge.push([x, y, mix(c, INK, amount)]);
    }
  for (const [x, y, c] of edge) img.set(x, y, c);
}

// ── Output ───────────────────────────────────────────────────

type Facing = '+row' | '+col' | '-row' | '-col' | 'none';
interface PieceEntry {
  file: string;
  density: number;
  footprint: [number, number];
  anchor: [number, number];
  faces: Facing;
  surface?: number;
  /** Where it came from: the starter pack's object, or drawn here. */
  from: string;
}
const pieces: Record<string, PieceEntry> = {};
const report: Record<string, Record<string, unknown>> = {};
const review: Array<{ name: string; img: Img; entry: PieceEntry }> = [];

function save(name: string, img: Img, entry: Omit<PieceEntry, 'file' | 'density'>): void {
  img.write(path.join(OUT, `${name}.png`));
  for (const k of [2, 4])
    lod(img, k, entry.anchor).img.write(path.join(OUT, `${name}@${D / k}.png`));
  pieces[name] = { file: `${name}.png`, density: D, ...entry };
  review.push({ name, img, entry: pieces[name] });
}

/** Opaque pixels on the outermost row or column of a cut (the object ran off its box). */
function edgeTouch(img: Img, box: [number, number, number, number], sheet: Img): number {
  // On the sheet: object pixels on the box's border with no magenta beyond it.
  const [x0, y0, x1, y1] = box;
  let n = 0;
  const isObj = (x: number, y: number) => {
    const c = sheet.get(x, y);
    return !!c && magenta(c[0], c[1], c[2]) <= BG;
  };
  for (let x = x0 - 3; x <= x1 + 3; x++)
    n += (isObj(x, y0 - 3) ? 1 : 0) + (isObj(x, y1 + 3) ? 1 : 0);
  for (let y = y0 - 3; y <= y1 + 3; y++)
    n += (isObj(x0 - 3, y) ? 1 : 0) + (isObj(x1 + 3, y) ? 1 : 0);
  void img;
  return n;
}
/** Background left in a piece: pixels of the backdrop's own hue (red and blue both high, about
 *  equal, green low; a pink sofa is not), and pinkish pixels on its silhouette (a halo). */
function leftover(img: Img): { magenta: number; halo: number } {
  let m = 0;
  let h = 0;
  for (let y = 0; y < img.h; y++)
    for (let x = 0; x < img.w; x++) {
      const c = img.get(x, y);
      if (!c) continue;
      if (c[0] > 170 && c[2] > 170 && Math.abs(c[0] - c[2]) < 60 && magenta(c[0], c[1], c[2]) > 60)
        m++;
      const edge =
        !img.get(x - 1, y) || !img.get(x + 1, y) || !img.get(x, y - 1) || !img.get(x, y + 1);
      if (edge && magenta(c[0], c[1], c[2]) > HALO && c[2] > c[1] + 60) h++;
    }
  return { magenta: m, halo: h };
}

// ── The starter pack ─────────────────────────────────────────

if (!fs.existsSync(path.join(SRC, 'starter-furniture.png'))) {
  console.error(`no starter pack in ${SRC} (pass --src <dir>)`);
  process.exit(1);
}
fs.mkdirSync(OUT, { recursive: true });
for (const f of fs.readdirSync(OUT)) if (f.endsWith('.png')) fs.unlinkSync(path.join(OUT, f));
const FURN = Img.read(path.join(SRC, 'starter-furniture.png'));
const STRUCT = Img.read(path.join(SRC, 'starter-structure.png'));

/** Each object's box in its sheet (its connected region on the magenta). */
const BOX: Record<string, [Img, [number, number, number, number]]> = {
  deskA: [FURN, [56, 61, 410, 379]],
  deskB: [FURN, [482, 61, 840, 379]],
  chairA: [FURN, [915, 86, 1076, 360]],
  chairB: [FURN, [1245, 84, 1405, 356]],
  bookshelf: [FURN, [1208, 377, 1422, 745]],
  sofaA: [FURN, [41, 420, 405, 734]],
  sofaB: [FURN, [476, 420, 835, 730]],
  coffeeTable: [FURN, [874, 507, 1161, 729]],
  plantTall: [FURN, [425, 742, 673, 1029]],
  plantPothos: [FURN, [122, 827, 311, 1019]],
  woodLight: [STRUCT, [129, 54, 394, 204]],
  woodDark: [STRUCT, [435, 51, 699, 204]],
  carpet: [STRUCT, [744, 51, 1010, 205]],
  stone: [STRUCT, [1050, 52, 1315, 204]],
  wallRow: [STRUCT, [50, 216, 227, 464]],
  wallCol: [STRUCT, [276, 229, 443, 465]],
  windowRow: [STRUCT, [527, 229, 704, 475]],
  windowCol: [STRUCT, [745, 229, 921, 475]],
  corner: [STRUCT, [44, 501, 259, 725]],
  elevator: [STRUCT, [351, 483, 552, 771]],
  vending: [STRUCT, [624, 505, 773, 773]],
  counter: [STRUCT, [839, 524, 1187, 808]],
  coffeeMachine: [STRUCT, [1269, 545, 1393, 773]],
  waterCooler: [STRUCT, [294, 776, 402, 1034]],
};

/** An object at its own pixels, and what the cut found. */
function native(key: string): { img: Img; pitch: number; halo: number; touch: number } {
  const [sheet, box] = BOX[key];
  const cut = cutObject(sheet, box);
  const p = pitch(cut.img);
  return {
    img: snap(cut.img, p),
    pitch: Math.round(p * 100) / 100,
    halo: cut.halo,
    touch: edgeTouch(cut.img, box, sheet),
  };
}

// Floors: the tile's top face mapped onto the 64×32 diamond (its rim and slab dropped).
function floorPiece(name: string, key: string): void {
  const n = native(key);
  const img = n.img;
  // The top face's corners: the leftmost, rightmost and topmost opaque pixels.
  let L: Pt = [img.w, 0];
  let R: Pt = [-1, 0];
  let T: Pt = [0, img.h];
  for (let y = 0; y < img.h; y++)
    for (let x = 0; x < img.w; x++) {
      if (!img.get(x, y)) continue;
      if (x < L[0]) L = [x, y];
      if (x > R[0]) R = [x, y];
      if (y < T[1]) T = [x, y];
    }
  const B: Pt = [L[0] + R[0] - T[0], L[1] + R[1] - T[1]];
  const width = R[0] - L[0] + 1;
  const k = (2 * HW) / width;
  const out = new Img(2 * HW, 2 * HH);
  // An art pixel and a half in from each edge: inside the tile's dark rim.
  const e = 1.5 / (width / 2);
  for (let y = 0; y < 2 * HH; y++)
    for (let x = 0; x < 2 * HW; x++) {
      const a = (x + 0.5 - HW) / HW;
      const b = (y + 0.5) / HH;
      const u = (a + b) / 2;
      const v = (b - a) / 2;
      if (u < 0 || v < 0 || u > 1 || v > 1) continue;
      const uu = e + u * (1 - 2 * e);
      const vv = e + v * (1 - 2 * e);
      const sx = T[0] + uu * (R[0] - T[0]) + vv * (L[0] - T[0]);
      const sy = T[1] + uu * (R[1] - T[1]) + vv * (L[1] - T[1]);
      const c = img.get(Math.floor(sx), Math.floor(sy));
      if (c) out.set(x, y, c);
    }
  save(name, out, {
    footprint: [1, 1],
    anchor: [HW, 2 * HH],
    faces: 'none',
    from: `starter-structure ${key}`,
  });
  report[name] = {
    from: key,
    pitch: n.pitch,
    haloRemoved: n.halo,
    edgeTouching: n.touch,
    leftover: leftover(out),
    // A true 2:1 face: height half its width, its top corner centred (px at density 4).
    alignErrorPx: {
      ratio: Math.round(Math.abs(B[1] - T[1] - width / 2) * k * 10) / 10,
      skew: Math.round(Math.abs(T[0] - (L[0] + R[0]) / 2) * k * 10) / 10,
    },
  };
}
floorPiece('floor-wood-light', 'woodLight');
floorPiece('floor-wood-dark', 'woodDark');
floorPiece('floor-carpet', 'carpet');
floorPiece('floor-stone', 'stone');

/** Each column's lowest opaque row (−1 where empty). */
const bottoms = (img: Img) =>
  Array.from({ length: img.w }, (_, x) => {
    for (let y = img.h - 1; y >= 0; y--) if (img.get(x, y)) return y;
    return -1;
  });

// Walls: the pack's panels at one scale, set by the window panel trimmed to four tiles of
// wall; the plain panels give one-tile strips. A strip's anchor is its tile's front corner:
// the right end of its base for a wall along the columns (its face to the lower left), the
// left end for one along the rows.
const WINDOW_TILES = 4;
const wallKeys = ['wallRow', 'wallCol', 'windowRow', 'windowCol', 'corner', 'elevator'];
const wallNative = Object.fromEntries(wallKeys.map((k) => [k, native(k)]));
// The window panel's run: its width less the end caps (about two art px each).
const WALL_F = (WINDOW_TILES * HW) / (wallNative.windowRow.img.w - 4);
const wallScaled = Object.fromEntries(
  wallKeys.map((k) => [k, scale(wallNative[k].img, WALL_F)]),
) as Record<string, Img>;
for (const k of wallKeys)
  report[`panel-${k}`] = {
    pitch: wallNative[k].pitch,
    haloRemoved: wallNative[k].halo,
    edgeTouching: wallNative[k].touch,
    scale: Math.round(WALL_F * 100) / 100,
  };

/** Every wall strip stands this tall at its anchor (the panels differ by a few px; a step
 *  where a window panel meets a plain one would show). */
let WALL_STRIP_H = 0;
function strip(name: string, panel: Img, x0: number, along: 'row' | 'col', from: string): void {
  const cols = panel.crop(x0, 0, x0 + HW, panel.h);
  const b = cols.bounds();
  let img = cols.crop(0, b.y0, HW, b.y1);
  const ax = along === 'row' ? HW : 0;
  const at0 = (bottoms(img)[ax === 0 ? 0 : HW - 1] ?? img.h - 1) + 1;
  const stretch = WALL_STRIP_H / at0;
  if (Math.abs(stretch - 1) > 0.001) {
    // Rows only, nearest, the base kept where it is.
    const out = new Img(HW, Math.round(img.h * stretch));
    for (let y = 0; y < out.h; y++)
      for (let x = 0; x < HW; x++) {
        const c = img.get(x, Math.min(img.h - 1, Math.floor((y + 0.5) / stretch)));
        if (c) out.set(x, y, c);
      }
    img = out;
  }
  const bot = bottoms(img);
  const ay = (along === 'row' ? bot[HW - 1] : bot[0]) + 1;
  // The base must run at 1:2 along the tile's edge: the worst column off that line.
  let err = 0;
  for (let x = 0; x < HW; x++) {
    if (bot[x] < 0) continue;
    const ideal = along === 'row' ? ay - 1 - (HW - 1 - x) / 2 : ay - 1 - x / 2;
    err = Math.max(err, Math.abs(bot[x] - ideal));
  }
  save(name, img, {
    footprint: [1, 1],
    anchor: [ax, ay],
    faces: along === 'row' ? '+row' : '+col',
    from,
  });
  report[name] = {
    from,
    alignErrorPx: Math.round(err * 10) / 10,
    heightPx: ay,
    stretched: Math.round(stretch * 1000) / 1000,
    leftover: leftover(img),
  };
}
// The common height: the plain wall along the columns, at its middle.
{
  const p = wallScaled.wallRow;
  const x = Math.round(p.w / 2 + HW / 2) - 1;
  WALL_STRIP_H = bottoms(p)[x] + 1 - p.bounds().y0;
  for (let y = 0; y < p.h; y++)
    if (p.get(x, y)) {
      WALL_STRIP_H = bottoms(p)[x] + 1 - y;
      break;
    }
}
for (const along of ['row', 'col'] as const) {
  const plain = wallScaled[along === 'row' ? 'wallRow' : 'wallCol'];
  strip(
    `wall-${along}`,
    plain,
    Math.round(plain.w / 2 - HW / 2),
    along,
    `starter-structure plain wall (middle strip)`,
  );
  const win = wallScaled[along === 'row' ? 'windowRow' : 'windowCol'];
  const start = Math.round((win.w - WINDOW_TILES * HW) / 2);
  for (let k = 0; k < WINDOW_TILES; k++)
    strip(
      `wall-${along}-win-${k}`,
      win,
      start + k * HW,
      along,
      `starter-structure window wall (strip ${k + 1}/${WINDOW_TILES})`,
    );
}

// The inside corner where the two back walls meet: its anchor is the corner's base (the room's
// back corner), under the panel's topmost point.
{
  const img = wallScaled.corner;
  let top = 0;
  outer: for (let y = 0; y < img.h; y++)
    for (let x = 0; x < img.w; x++)
      if (img.get(x, y)) {
        top = x;
        break outer;
      }
  const bot = bottoms(img);
  let ay = img.h;
  for (let x = top - 2; x <= top + 2; x++) if (bot[x] >= 0) ay = Math.min(ay, bot[x] + 1);
  save('wall-corner', img, {
    footprint: [1, 1],
    anchor: [top, ay],
    faces: 'none',
    from: 'starter-structure corner',
  });
  report['wall-corner'] = { leftover: leftover(img) };
}

// The elevator's doors: the pack's elevator wall cut to its grey doors and frame (no plaster:
// they go on a back wall that has its own), fitted to the two wall tiles an elevator takes, and
// the same with the doors slid open on the dark car.
let liftTiles = 2;
{
  const img = wallNative.elevator.img;
  const grey = (c: Rgba | null) =>
    !!c && Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2]) < 28 && c[0] > 70 && c[0] < 215;
  let [x0, y0, x1, y1] = [img.w, img.h, 0, 0];
  for (let y = 0; y < img.h; y++)
    for (let x = 0; x < Math.round(img.w * 0.8); x++)
      if (grey(img.get(x, y))) [x0, y0, x1, y1] = [Math.min(x0, x), Math.min(y0, y), Math.max(x1, x + 1), Math.max(y1, y + 1)];
  // The doors' columns only, every pixel in their bounds (the frame's dark edges included).
  const door = img.crop(x0, y0, x1, y1);
  const run = liftTiles * HW;
  const w = Math.round(run * 0.86);
  const scaled = scale(door, w / door.w);
  const bot = bottoms(scaled);
  const inset = (run - w) / 2;
  const anchor: [number, number] = [Math.round(w + inset), Math.round(bot[w - 1] + 1 + inset / 2)];
  save('lift-doors', scaled, { footprint: [liftTiles, 1], anchor, faces: '+row', from: 'starter-structure elevator wall (doors)' });
  // Open: the light grey of the leaves becomes the car's dark inside, the frame kept.
  const open = new Img(scaled.w, scaled.h);
  open.data.set(scaled.data);
  const edge = Math.round(scaled.w * 0.12);
  for (let y = 0; y < scaled.h; y++)
    for (let x = edge; x < scaled.w - edge; x++) {
      const c = scaled.get(x, y);
      if (c && grey(c) && c[0] > 110 && y > scaled.h * 0.12 && y < bot[x] - 2)
        open.set(x, y, mix(hex('#2f3446'), hex('#454c63'), y / scaled.h));
    }
  save('lift-doors-open', open, { footprint: [liftTiles, 1], anchor, faces: '+row', from: 'starter-structure elevator wall (doors, opened)' });
  report['lift-doors'] = { tiles: liftTiles, leftover: leftover(scaled) };
}

// Furniture: each scaled so its picture spans its footprint's width (`fill`: the share of it
// the object covers, its size in the game), standing centred on it.
function furniture(
  name: string,
  key: string,
  footprint: [number, number],
  fill: number,
  faces: Facing,
  extra: { surface?: number } = {},
): void {
  const n = native(key);
  const full = (footprint[0] + footprint[1]) * HW;
  const f = (full * fill) / n.img.w;
  const img = scale(n.img, f);
  const ax = Math.round((img.w - full) / 2 + footprint[0] * HW);
  // Its lowest pixel stands on the floor at the front corner (a leg, a wheel, the base).
  save(name, img, { footprint, anchor: [ax, img.h], faces, ...extra, from: `starter ${key}` });
  report[name] = {
    from: key,
    pitch: n.pitch,
    scale: Math.round(f * 100) / 100,
    footprint,
    fill,
    // How far the picture's width is from the footprint's diamond's (density-4 px).
    alignErrorPx: Math.abs(img.w - full),
    haloRemoved: n.halo,
    edgeTouching: n.touch,
    leftover: leftover(img),
  };
}
furniture('desk', 'deskA', [3, 1], 1.05, '+row', { surface: 12 * D });
furniture('desk-b', 'deskB', [3, 1], 1.05, '+row', { surface: 12 * D });
furniture('chair', 'chairA', [1, 1], 0.95, '+row');
furniture('chair-side', 'chairB', [1, 1], 0.95, '+col');
furniture('sofa', 'sofaA', [2, 1], 1.15, '+row');
furniture('sofa-side', 'sofaB', [1, 2], 1.15, '+col');
furniture('coffee-table', 'coffeeTable', [2, 2], 0.82, 'none');
furniture('plant', 'plantPothos', [1, 1], 0.8, 'none');
furniture('plant-tall', 'plantTall', [1, 1], 1.0, 'none');
furniture('bookshelf', 'bookshelf', [1, 2], 1.0, '+col');
furniture('counter', 'counter', [2, 1], 1.2, '+row');
furniture('coffee-machine', 'coffeeMachine', [1, 1], 0.7, '+row');
furniture('vending', 'vending', [1, 1], 1.15, '+row');
furniture('water-cooler', 'waterCooler', [1, 1], 0.7, '+row');

// ── The structural pieces (not in the pack), in its colours ──

const plain = wallScaled.wallRow;
const at = (fx: number, fy: number): Rgba =>
  plain.get(Math.round(plain.w * fx), Math.round(plain.h * fy)) ?? hex('#d9c3a5');
const PLASTER = at(0.5, 0.55);
const CAP = at(0.5, 0.12);
const BASE = (() => {
  const x = Math.round(plain.w / 2);
  return plain.get(x, bottoms(plain)[x] - 3) ?? hex('#a0704a');
})();
const SLAB = 6; // ISO_SLAB_H (world px)
const C = {
  plate: hex('#3a3f52'),
  slabLit: hex('#8c8f9c'),
  slabShade: hex('#5f6272'),
  slabEdge: hex('#b6b8c2'),
  pave: [hex('#34384a'), hex('#303444'), hex('#272a38')],
  frame: hex('#5c6170'),
  frameLit: hex('#8d93a3'),
  glass: hex('#5d8fc2'),
  glassDark: hex('#3f6a99'),
  car: hex('#c9ced8'),
  carShade: hex('#8e97a8'),
  carDark: hex('#2f3446'),
  lamp: hex('#f0b040'),
};
const DIAMOND: [number, number] = [HW, 2 * HH];

{
  const f = new Frame(1, 1, 0);
  f.face(0, 0, 1, 1, 0, C.plate);
  save('plate', f.img, { footprint: [1, 1], anchor: DIAMOND, faces: 'none', from: 'drawn' });
  for (const side of ['row', 'col'] as const) {
    const s = new Frame(1, 1, 0, SLAB * D);
    const face = (z0: number, z1: number, c: Rgba) =>
      side === 'row' ? s.row(0, 1, 1, z0, z1, c) : s.col(1, 0, 1, z0, z1, c);
    const c = side === 'row' ? C.slabLit : C.slabShade;
    face(-SLAB, 0, c);
    face(-0.5, 0, side === 'row' ? C.slabEdge : mix(C.slabEdge, c, 0.5));
    face(-SLAB, -SLAB + 0.5, mix(c, INK, 0.5));
    save(`slab-${side}`, s.img, {
      footprint: [1, 1],
      anchor: DIAMOND,
      faces: 'none',
      from: 'drawn',
    });
  }
  const shape = new Frame(1, 1, 0);
  shape.face(0, 0, 1, 1, 0, hex('#000000'));
  const pave = new Img(2 * HW, 2 * HH);
  for (let y = 0; y < 2 * HH; y++)
    for (let x = 0; x < 2 * HW; x++) {
      if (!shape.img.get(x, y)) continue;
      const a = (x + 0.5 - HW) / HW;
      const b = (y + 0.5) / HH;
      const seam = (a + b) / 2 < 1 / 32 || (b - a) / 2 < 1 / 32;
      pave.set(x, y, seam ? C.pave[2] : (x * 7 + y * 3) % 23 === 0 ? C.pave[1] : C.pave[0]);
    }
  save('pavement', pave, { footprint: [1, 1], anchor: DIAMOND, faces: 'none', from: 'drawn' });
}

// A cut-away wall: a low box in the plaster, its baseboard and its cap.
{
  const LOW = 7;
  const f = new Frame(1, 1, LOW * D);
  f.row(0, 1, 1, 0, LOW, PLASTER);
  f.col(1, 0, 1, 0, LOW, mix(PLASTER, INK, 0.18));
  f.row(0, 1, 1, 0, 1.5, BASE);
  f.col(1, 0, 1, 0, 1.5, mix(BASE, INK, 0.2));
  f.face(0, 0, 1, 1, LOW, CAP);
  save('wall-low', f.img, {
    footprint: [1, 1],
    anchor: [HW, f.img.h],
    faces: 'none',
    from: 'drawn (pack colours)',
  });
}

// The shaft: one storey's segment of a glass column in a grey frame; the car inside it.
{
  const H = 40;
  // Two tiles along the columns, as long as the doors along the rows (they are on its face
  // towards the viewer's right).
  const n = liftTiles;
  const f = new Frame(2, n, H * D);
  f.box(0, 0, 2, n, 0, H, { top: C.frame, lit: C.glass, shade: C.glassDark });
  for (const z of [0, H - 1.5])
    f.box(0, 0, 2, n, z, z + 1.5, { top: C.frameLit, lit: C.frameLit, shade: C.frame });
  for (const u of [0, 2 - 0.06]) f.row(u, u + 0.06, n, 0, H, C.frame);
  for (const v of [0, n - 0.06]) f.col(2, v, v + 0.06, 0, H, mix(C.frame, INK, 0.2));
  f.row(0.3, 0.38, n, 8, 30, mix(C.glass, hex('#ffffff'), 0.35));
  outline(f.img, 0.45);
  save('lift-shaft', f.img, {
    footprint: [2, n],
    anchor: [2 * HW, f.img.h],
    faces: 'none',
    from: 'drawn',
  });
  const car = new Frame(2, n, 34 * D);
  car.box(0.25, 0.3, 1.75, n - 0.3, 0, 32, { top: C.carShade, lit: C.car, shade: C.carShade });
  car.row(0.4, 1.6, n - 0.3, 14, 27, C.carDark);
  car.col(1.75, 0.45, n - 0.45, 14, 27, mix(C.carDark, INK, 0.3));
  car.col(1.75, 0.3, n - 0.3, 29, 30, C.lamp);
  outline(car.img, 0.5);
  save('lift-car', car.img, {
    footprint: [2, n],
    anchor: [2 * HW, car.img.h],
    faces: 'none',
    from: 'drawn',
  });
}

// The lobby's board, a whiteboard and the lobby's bench: the pack has none of them yet.
{
  const ink = {
    frame: hex('#2a2d40'),
    frameLit: hex('#3a3e56'),
    screen: hex('#141824'),
    dot: hex('#22304d'),
    dotHi: hex('#3d5a8a'),
  };
  // Low enough (the height of a wall) that the room behind it still shows over it.
  const [fw, fh] = [28, 9];
  const H = 34;
  const f = new Frame(fw, fh, H * D);
  for (const u of [3, 14, 25])
    f.box(u, 0.3, u + 0.25, 0.55, 0, 6, { top: ink.frameLit, lit: ink.frameLit, shade: ink.frame });
  f.box(0.2, 0.2, fw - 0.2, 0.5, 6, H, { top: ink.frameLit, lit: ink.frame, shade: ink.frame });
  f.row(0.5, fw - 0.5, 0.5, 8, H - 2, ink.screen);
  for (let z = 10; z < H - 3; z += 2)
    for (let u = 0.75; u < fw - 0.6; u += 0.1875)
      f.row(u, u + 0.0625, 0.5, z, z + 0.5, (z + Math.round(u * 16)) % 7 ? ink.dot : ink.dotHi);
  outline(f.img, 0.5);
  save('board', f.img, {
    footprint: [fw, fh],
    anchor: [fw * HW, f.img.h],
    faces: '+row',
    from: 'drawn',
  });

  const wb = {
    frame: hex('#4a4e4d'),
    board: hex('#efebe8'),
    ink: hex('#5a4f50'),
    red: hex('#c25769'),
    blue: hex('#416c94'),
    tray: hex('#73787e'),
  };
  const w = new Frame(2, 1, 32 * D);
  const v = 1.03; // just off the wall's face
  w.row(0.08, 1.92, v, 12, 31, wb.frame);
  w.row(0.12, 1.88, v, 12.75, 30.25, wb.board);
  w.row(0.3, 1.0, v, 26, 26.75, wb.ink);
  w.row(0.3, 1.4, v, 23, 23.75, wb.ink);
  w.row(0.3, 0.8, v, 20, 20.75, wb.blue);
  w.row(1.2, 1.6, v, 16.5, 18.5, wb.red);
  w.row(0.2, 1.8, v, 11, 12, wb.tray);
  save('whiteboard', w.img, {
    footprint: [2, 1],
    anchor: [2 * HW, w.img.h],
    faces: '+row',
    from: 'drawn',
  });

  const wood = { top: hex('#c08048'), lit: hex('#9a6234'), shade: hex('#6e4222') };
  const metal = { top: hex('#73787e'), lit: hex('#73787e'), shade: hex('#394449') };
  const b = new Frame(2, 1, 12 * D);
  for (const [u, vv] of [
    [0.12, 0.2],
    [1.78, 0.2],
    [0.12, 0.7],
    [1.78, 0.7],
  ])
    b.box(u, vv, u + 0.1, vv + 0.1, 0, 5, metal);
  for (let k = 0; k < 3; k++) b.box(0.05, 0.12 + k * 0.22, 1.95, 0.3 + k * 0.22, 5, 6, wood);
  b.box(0.05, 0.72, 1.95, 0.84, 7, 12, wood);
  outline(b.img);
  save('bench', b.img, {
    footprint: [2, 1],
    anchor: [2 * HW, b.img.h],
    faces: '-row',
    from: 'drawn',
  });
}

// ── The manifest ─────────────────────────────────────────────

/** Furniture type -> the piece it wears (`mirror`: flipped, footprint turned). `none`: not
 *  drawn (a PC: the desk has its monitor). A type not listed stands as its top-down sprite. */
const types: Record<string, { piece: string; mirror?: boolean }> = {
  DESK_FRONT: { piece: 'desk' },
  PC_FRONT_OFF: { piece: 'none' },
  PC_FRONT_ON_1: { piece: 'none' },
  PC_FRONT_ON_2: { piece: 'none' },
  PC_FRONT_ON_3: { piece: 'none' },
  CUSHIONED_BENCH: { piece: 'chair' },
  CUSHIONED_CHAIR_FRONT: { piece: 'chair' },
  CUSHIONED_CHAIR_BACK: { piece: 'chair' },
  CUSHIONED_CHAIR_SIDE: { piece: 'chair-side' },
  WOODEN_CHAIR_FRONT: { piece: 'chair' },
  WOODEN_CHAIR_BACK: { piece: 'chair' },
  PLANT: { piece: 'plant' },
  POT: { piece: 'plant' },
  CACTUS: { piece: 'plant' },
  PLANT_2: { piece: 'plant-tall' },
  TALL_PLANT: { piece: 'plant-tall' },
  LARGE_PLANT: { piece: 'plant-tall' },
  SOFA_FRONT: { piece: 'sofa' },
  SOFA_BACK: { piece: 'sofa' },
  SOFA_SIDE: { piece: 'sofa-side' },
  'SOFA_SIDE:left': { piece: 'sofa-side' },
  COFFEE_TABLE: { piece: 'coffee-table' },
  SMALL_TABLE_FRONT: { piece: 'counter' },
  COFFEE: { piece: 'coffee-machine' },
  LED_BOARD: { piece: 'board' },
  WHITEBOARD: { piece: 'whiteboard' },
  LOBBY_BENCH: { piece: 'bench' },
};

const manifest = {
  note: 'ISO-PILOT pilot assets (cld/scripts/gen-iso-art.ts), cut from the owner starter pack: not finished art. density: source px per world px (a 16 px tile is a 64x32 diamond at 4). anchor: the pixel at the footprint front corner on the floor, at that density. faces: +row lower left, +col lower right, -row upper right, -col upper left. name@2.png and name@1.png: the same piece at densities 2 and 1.',
  floors: {
    default: 'floor-wood-light',
    '1': 'floor-carpet',
    '7': 'floor-wood-dark',
    '9': 'floor-stone',
  },
  walls: {
    row: 'wall-row',
    col: 'wall-col',
    rowWindows: Array.from({ length: WINDOW_TILES }, (_, k) => `wall-row-win-${k}`),
    colWindows: Array.from({ length: WINDOW_TILES }, (_, k) => `wall-col-win-${k}`),
    corner: 'wall-corner',
    low: 'wall-low',
  },
  lift: { doors: 'lift-doors', doorsOpen: 'lift-doors-open', shaft: 'lift-shaft', car: 'lift-car' },
  pieces,
  types,
};
fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2) + '\n');

// ── The review sheet: every file on its footprint's diamond, its anchor marked ──

{
  const PAD = 24;
  const WIDTH = 1800;
  const rows: Array<typeof review> = [[]];
  let w = PAD;
  for (const r of review) {
    const cw = Math.max(260, r.img.w + PAD);
    if (w + cw > WIDTH) (rows.push([]), (w = PAD));
    rows[rows.length - 1].push(r);
    w += cw;
  }
  const heights = rows.map((rr) => Math.max(...rr.map((r) => r.img.h)) + 2 * PAD);
  const sheet = new Img(
    WIDTH,
    heights.reduce((a, b) => a + b, PAD),
  );
  for (let i = 0; i < sheet.w * sheet.h; i++) sheet.data.set([46, 50, 64, 255], i * 4);
  let y = PAD;
  rows.forEach((rr, k) => {
    let x = PAD;
    const base = y + heights[k] - PAD;
    for (const r of rr) {
      const cw = Math.max(260, r.img.w + PAD);
      const [fw, fh] = r.entry.footprint;
      const ax = x + Math.round((cw - PAD) / 2) + (fw - fh) * HW * 0;
      const back: Pt = [ax - (fw - fh) * HW, base - (fw + fh) * HH];
      const pts: Pt[] = [
        back,
        [back[0] + fw * HW, back[1] + fw * HH],
        [ax, base],
        [back[0] - fh * HW, back[1] + fh * HH],
      ];
      for (let s = 0; s < 4; s++) {
        const [x0, y0] = pts[s];
        const [x1, y1] = pts[(s + 1) % 4];
        const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
        for (let t = 0; t <= n; t++)
          sheet.set(
            Math.round(x0 + ((x1 - x0) * t) / n),
            Math.round(y0 + ((y1 - y0) * t) / n),
            [150, 160, 190, 255],
          );
      }
      const ox = ax - r.entry.anchor[0];
      const oy = base - r.entry.anchor[1];
      for (let yy = 0; yy < r.img.h; yy++)
        for (let xx = 0; xx < r.img.w; xx++) {
          const c = r.img.get(xx, yy);
          if (c) sheet.set(ox + xx, oy + yy, c);
        }
      for (let d = -3; d <= 3; d++) {
        sheet.set(ax + d, base, [255, 80, 80, 255]);
        sheet.set(ax, base + d, [255, 80, 80, 255]);
      }
      x += cw;
    }
    y += heights[k];
  });
  fs.mkdirSync(SHEET_OUT, { recursive: true });
  sheet.write(path.join(SHEET_OUT, 'review-sheet.png'));
  fs.writeFileSync(
    path.join(SHEET_OUT, 'review-sheet-order.txt'),
    rows.map((rr) => rr.map((r) => r.name).join('  ')).join('\n') + '\n',
  );
}
console.log(`${Object.keys(pieces).length} pieces -> ${OUT}`);
