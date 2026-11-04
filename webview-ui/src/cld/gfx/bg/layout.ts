/**
 * BACKGROUND layout: where the roads, plots and what stands on them are, in the building's own
 * floor grid (tile (col, row) of the first floor; a tile is a 16 x 8 diamond, see projection.ts).
 * Pure and stateless: everything is a function of (seed, mix, the building's size, a tile or a
 * plot), so the same seed puts the same house in the same place whatever part of the world is
 * drawn, and day and night (a palette only) share every position.
 */
import type { BackgroundMix } from '../../../../../core/src/messages.js';
import {
  BG_BLOCK_TILES,
  BG_HOUSE_H,
  BG_HOUSE_TILES,
  BG_LAMP_HEIGHT,
  BG_PAD_TILES,
  BG_ROAD_TILES,
  BG_TOWER_STOREYS,
  BG_TOWER_TILES,
  BG_TREE_R,
  BG_TREE_TRUNK,
  ISO_HALF_H,
  ISO_HALF_W,
  ISO_STOREY_H,
} from '../../../constants.js';

/** The building's first floor in tiles: what the main plot is built round. */
export interface Footprint {
  cols: number;
  rows: number;
}

/** Deterministic noise in [0, 1) of three whole numbers. */
export function hash(a: number, b: number, c = 0): number {
  let h = (Math.imul(a | 0, 374761393) + Math.imul(b | 0, 668265263) + Math.imul(c | 0, 2147483647)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

// ── One axis: the main plot, then a road and a plot, again and again, both ways ──────────

export interface AxisCell {
  /** The plot this tile belongs to (a road tile: the plot before it, towards the main plot). */
  plot: number;
  /** Tile inside its plot, counted from the plot's lowest tile; -1 on a road. */
  t: number;
  /** The plot's length in tiles (0 on a road). */
  n: number;
  /** Tile across a road (0 = beside the plot nearer the main plot); -1 on a plot. */
  road: number;
}

const PERIOD = BG_ROAD_TILES + BG_BLOCK_TILES;

/** First tile and length of plot `k` on an axis whose building is `len` tiles long. */
export function plotSpan(k: number, len: number): { start: number; n: number } {
  if (k === 0) return { start: -BG_PAD_TILES, n: len + 2 * BG_PAD_TILES };
  if (k > 0) return { start: len + BG_PAD_TILES + BG_ROAD_TILES + (k - 1) * PERIOD, n: BG_BLOCK_TILES };
  const end = -BG_PAD_TILES - BG_ROAD_TILES - (-k - 1) * PERIOD;
  return { start: end - BG_BLOCK_TILES, n: BG_BLOCK_TILES };
}

/** What tile `i` of an axis is: a plot's tile or a road's. */
export function axisCell(i: number, len: number): AxisCell {
  const lo = -BG_PAD_TILES;
  const hi = len + BG_PAD_TILES;
  if (i >= lo && i < hi) return { plot: 0, t: i - lo, n: hi - lo, road: -1 };
  const above = i >= hi;
  const u = above ? i - hi : lo - 1 - i;
  const q = Math.floor(u / PERIOD);
  const w = u - q * PERIOD;
  const sign = above ? 1 : -1;
  if (w < BG_ROAD_TILES) return { plot: sign * q, t: -1, n: 0, road: w };
  const t = w - BG_ROAD_TILES;
  return { plot: sign * (q + 1), t: above ? t : BG_BLOCK_TILES - 1 - t, n: BG_BLOCK_TILES, road: -1 };
}

// ── Plots ───────────────────────────────────────────────────

export type PlotKind = 'main' | 'empty' | 'tower' | 'houses' | 'park' | 'pond';

/** Where the owner's next buildings will stand: the two plots in front of the main one. */
export const EMPTY_PLOTS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [0, 1],
];

/** What fills plot (ki, kj) (ki along the columns, kj along the rows). */
export function plotKind(seed: number, mix: BackgroundMix, ki: number, kj: number): PlotKind {
  if (ki === 0 && kj === 0) return 'main';
  if (EMPTY_PLOTS.some(([a, b]) => a === ki && b === kj)) return 'empty';
  const r = hash(ki, kj, seed);
  const park = (): PlotKind => (hash(ki, kj, seed + 1) < 0.3 ? 'pond' : 'park');
  if (mix === 'houses') return r < 0.64 ? 'houses' : park();
  if (mix === 'towers') return r < 0.66 ? 'tower' : park();
  return r < 0.36 ? 'tower' : r < 0.78 ? 'houses' : park();
}

// ── Objects standing on the ground ─────────────────────────

export interface BgObject {
  kind: 'tower' | 'house' | 'tree' | 'lamp';
  /** Ground point, tiles (col, row; fractions allowed). */
  a: number;
  b: number;
  /** Footprint (tiles) and height (iso px) of a tower or house; a tree's crown radius (iso px). */
  size: number;
  h: number;
  /** A house's colour, a tree's crown, a window pattern: a stable pick. */
  pick: number;
}

/** Iso px of the ground point at tile (a, b) (level 0, no lift). */
export const groundAt = (a: number, b: number) => ({
  x: (a - b) * ISO_HALF_W,
  y: (a + b) * ISO_HALF_H,
});

/** An object's bounding box in iso px, for keeping the ring clear of the building. */
export function objectBox(o: BgObject): { x0: number; y0: number; x1: number; y1: number } {
  const g = groundAt(o.a, o.b);
  if (o.kind === 'tower' || o.kind === 'house') {
    const half = o.size * ISO_HALF_W;
    const roof = o.kind === 'house' ? o.size * ISO_HALF_H : 0;
    return { x0: g.x - half, x1: g.x + half, y0: g.y - o.h - roof - half / 2, y1: g.y + half / 2 };
  }
  const r = o.kind === 'tree' ? o.size + 1 : 2;
  const top = o.kind === 'tree' ? BG_TREE_TRUNK.h + 2 * o.size + 2 : BG_LAMP_HEIGHT + 3;
  return { x0: g.x - r, x1: g.x + r, y0: g.y - top, y1: g.y + 2 };
}

/** The part of the world a drawing needs: plots ki in [k0, k1], kj in [l0, l1]. */
export interface PlotRange {
  k0: number;
  k1: number;
  l0: number;
  l1: number;
}

/** Everything that stands on the plots of `range`, none in the way of `avoid` (iso px, the
 *  building's box): a tower or house that would be drawn over it is left out. */
export function objectsIn(
  seed: number,
  mix: BackgroundMix,
  fp: Footprint,
  range: PlotRange,
  avoid: { x0: number; y0: number; x1: number; y1: number },
): BgObject[] {
  const out: BgObject[] = [];
  const clear = (o: BgObject) => {
    const b = objectBox(o);
    return b.x1 < avoid.x0 || b.x0 > avoid.x1 || b.y1 < avoid.y0 || b.y0 > avoid.y1;
  };
  const add = (o: BgObject, solid = false) => {
    if (!solid || clear(o)) out.push(o);
  };
  for (let ki = range.k0; ki <= range.k1; ki++)
    for (let kj = range.l0; kj <= range.l1; kj++) {
      const kind = plotKind(seed, mix, ki, kj);
      const A = plotSpan(ki, fp.cols);
      const B = plotSpan(kj, fp.rows);
      const s = seed + ki * 7919 + kj * 104729;
      // Lamps: the pavement's four corners and the middle of each side.
      const la = [A.start, A.start + (A.n >> 1), A.start + A.n - 1];
      const lb = [B.start, B.start + (B.n >> 1), B.start + B.n - 1];
      for (const a of la)
        for (const b of lb)
          if (a !== la[1] || b !== lb[1]) add({ kind: 'lamp', a: a + 0.5, b: b + 0.5, size: 0, h: 0, pick: 0 });
      const cx = A.start + A.n / 2;
      const cy = B.start + B.n / 2;
      if (kind === 'main') {
        // Trees on the back pavement (the front ones would stand in the building).
        for (let t = 3; t < A.n - 3; t += 4) add({ kind: 'tree', a: A.start + t + 0.5, b: B.start + 0.5, size: BG_TREE_R, h: 0, pick: t });
        for (let t = 3; t < B.n - 3; t += 4) add({ kind: 'tree', a: A.start + 0.5, b: B.start + t + 0.5, size: BG_TREE_R, h: 0, pick: t });
      } else if (kind === 'tower') {
        // Whole storeys of ours (building-a-1104): a neighbour reads at our building's scale.
        const span = BG_TOWER_STOREYS.max - BG_TOWER_STOREYS.min + 1;
        const h = ISO_STOREY_H * (BG_TOWER_STOREYS.min + Math.floor(hash(ki, kj, seed + 2) * span));
        add({ kind: 'tower', a: cx, b: cy, size: BG_TOWER_TILES, h, pick: s }, true);
        for (const [da, db] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const)
          add({ kind: 'tree', a: cx + da * (BG_TOWER_TILES / 2 + 1.5), b: cy + db * (BG_TOWER_TILES / 2 + 1.5), size: BG_TREE_R, h: 0, pick: s + da + db });
      } else if (kind === 'houses') {
        const q = A.n / 4;
        let k = 0;
        for (const da of [-1, 1])
          for (const db of [-1, 1]) {
            if (hash(ki + k, kj, seed + 3) < 0.88)
              add({ kind: 'house', a: cx + da * q, b: cy + db * q, size: BG_HOUSE_TILES, h: BG_HOUSE_H + Math.floor(hash(k, ki, kj + seed) * 5), pick: s + k }, true);
            k++;
          }
        for (let n = 0; n < 5; n++)
          add({ kind: 'tree', a: A.start + 1.5 + hash(n, ki, seed + 4) * (A.n - 3), b: B.start + 1.5 + hash(n, kj, seed + 5) * (B.n - 3), size: BG_TREE_R, h: 0, pick: s + n });
      } else if (kind === 'park' || kind === 'pond') {
        for (let a = 1; a < A.n - 1; a++)
          for (let b = 1; b < B.n - 1; b++) {
            if (kind === 'pond' && a > 3 && a < A.n - 4 && b > 3 && b < B.n - 4) continue;
            if (hash(A.start + a, B.start + b, seed + 6) < 0.2)
              add({ kind: 'tree', a: A.start + a + 0.5, b: B.start + b + 0.5, size: BG_TREE_R + Math.floor(hash(a, b, seed + 7) * 3), h: 0, pick: a * 31 + b });
          }
      }
    }
  return out;
}

/** The plots a rectangle of iso px (x0..x1, y0..y1) touches, a plot wider for safety. */
export function plotsIn(
  fp: Footprint,
  box: { x0: number; y0: number; x1: number; y1: number },
): PlotRange {
  // The ground tile under each corner of the box, then every plot those tiles span.
  const tiles = [
    [box.x0, box.y0],
    [box.x1, box.y0],
    [box.x0, box.y1],
    [box.x1, box.y1],
  ].map(([x, y]) => ({ a: (x / ISO_HALF_W + y / ISO_HALF_H) / 2, b: (y / ISO_HALF_H - x / ISO_HALF_W) / 2 }));
  const lo = (k: 'a' | 'b') => Math.min(...tiles.map((t) => t[k]));
  const hi = (k: 'a' | 'b') => Math.max(...tiles.map((t) => t[k]));
  const kOf = (i: number, len: number) => axisCell(Math.floor(i), len).plot;
  return {
    k0: kOf(lo('a'), fp.cols) - 2,
    k1: kOf(hi('a'), fp.cols) + 2,
    l0: kOf(lo('b'), fp.rows) - 2,
    l1: kOf(hi('b'), fp.rows) + 2,
  };
}
