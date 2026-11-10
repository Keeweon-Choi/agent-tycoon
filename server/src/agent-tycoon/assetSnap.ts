/**
 * ASSET-SNAP: turns "big-block" pixel art (every art pixel drawn as a 6-20 px block with soft,
 * anti-aliased edges and a slightly drifting grid, as image generators draw it) into a true-pixel
 * sprite the game can use (16 px tiles, integer zoom). Pure functions over decoded RGBA; no file or
 * network access (the CLI next to this file does the PNG I/O). Steps:
 *   1. findGrid: one block size from the colour-change edges (non-integer ok), then an elastic chain
 *      of block boundaries per axis that follows the drift; a size hint skips the size search
 *   2. sampleCells: one colour per block, the DOMINANT colour of its centre, not the average
 *   3. dropBorderBackground + mergePalette: opaque black/white border blocks go, near colours merge
 *   4. extractFigures: connected components of the true-pixel image, each trimmed
 *   5. fitReport: how a figure fits the game (tile footprint, character frame, scale)
 */
import {
  CHAR_FRAME_H,
  CHAR_FRAME_W,
  FLOOR_TILE_SIZE,
  PNG_ALPHA_THRESHOLD,
} from '../../../core/src/assets/constants.js';

export interface Rgba {
  width: number;
  height: number;
  /** width * height * 4 bytes, straight (non-premultiplied) RGBA. */
  data: Uint8Array;
}

export interface AxisGrid {
  /** Mean block size in source pixels (fractional). */
  size: number;
  /** Position of the first boundary modulo the size. */
  offset: number;
  /** Share of boundaries that sit on a clear edge (the rest follow the lattice spacing). */
  confidence: number;
  /** Measured block boundaries in source pixels, ascending (the first may be 0, the last the image end). */
  cuts: number[];
}

export interface Grid {
  x: AxisGrid;
  y: AxisGrid;
  /** How far the best size stands above the typical one in the search (a clear lattice is above WEAK_EVIDENCE; Infinity when the size was given). */
  evidence: number;
}

/** Below this evidence the image has no clear lattice and the size is a guess: pass a size hint instead. */
export const WEAK_EVIDENCE = 15;
/** With weak evidence, sizes scoring within this share of the best are all candidates. */
const WEAK_SLACK = 0.2;

/** Smallest and largest block size looked for, in source pixels. */
export const MIN_BLOCK = 4;
export const MAX_BLOCK = 40;
/** Nominal sizes are tried at SIZE_STEP, then the winner at SIZE_FINE_STEP within SIZE_FINE_SPAN. */
const SIZE_STEP = 0.2;
const SIZE_FINE_STEP = 0.02;
const SIZE_FINE_SPAN = 0.3;
/** Edge strength (share of the EDGE_REFERENCE percentile of local maxima) below which a position gains nothing, and from which it gains fully. */
const EDGE_REFERENCE = 0.9;
const EDGE_FAINT = 0.1;
const EDGE_CLEAR = 0.5;
/** A boundary counts as sitting on an edge from this gain on. */
const EDGE_ON = 0.5;
/** Every boundary costs this much, so the finest lattice is chosen only when its extra edges pay for it. */
const CUT_COST = 0.25;
/** A block may differ from the nominal size by this many pixels (and at most this share of it); the full deviation costs STRETCH_COST. */
const MAX_DEVIATION_PX = 4;
const MAX_DEVIATION_SHARE = 0.35;
const STRETCH_COST = 0.5;
/** Pixels with less alpha than this are background when sampling and when measuring edges. */
const BG_ALPHA = 128;
/** The centre share of a block that is sampled (the soft edges are left out). */
const INNER_SHARE = 0.5;
/** Colour bucket width (per channel) used to find a block's dominant colour. */
const BUCKET = 16;
/** A block counts as background when fewer than this share of its centre is opaque. */
const MIN_OPAQUE_SHARE = 0.5;
/** Colours closer than this (Euclid RGB) merge into the more common one. */
export const MERGE_DISTANCE = 22;
/** A border background block must be this close to the border's main colour. */
const BORDER_TOLERANCE = 40;
/** Share of opaque border blocks above which the image has an opaque border to drop. */
const OPAQUE_BORDER_SHARE = 0.9;
const DARK_MAX = 48;
const LIGHT_MIN = 208;
/** Cells this close (Chebyshev) belong to one figure, so a detached sparkle stays with its figure. */
export const FIGURE_GAP = 2;
/** Figures with fewer cells than this are specks and dropped. */
const MIN_FIGURE_CELLS = 3;
const OPAQUE = 255;
const CHANNELS = 4;

const idx = (img: Rgba, x: number, y: number) => (y * img.width + x) * CHANNELS;

/** Premultiplied RGBA of one pixel; transparent pixels are all zero whatever their RGB says. */
function premul(img: Rgba, i: number): [number, number, number, number] {
  const a = img.data[i + 3];
  if (a < BG_ALPHA) return [0, 0, 0, 0];
  return [img.data[i], img.data[i + 1], img.data[i + 2], a];
}

/** Colour change between each pixel and its left (axis x) or upper (axis y) neighbour, summed along the line. */
function edgeProfile(img: Rgba, axis: 'x' | 'y'): Float64Array {
  const n = axis === 'x' ? img.width : img.height;
  const m = axis === 'x' ? img.height : img.width;
  const e = new Float64Array(n);
  for (let k = 1; k < n; k++) {
    let sum = 0;
    for (let j = 0; j < m; j++) {
      const a = premul(img, axis === 'x' ? idx(img, k, j) : idx(img, j, k));
      const b = premul(img, axis === 'x' ? idx(img, k - 1, j) : idx(img, j, k - 1));
      sum +=
        Math.abs(a[0] - b[0]) +
        Math.abs(a[1] - b[1]) +
        Math.abs(a[2] - b[2]) +
        Math.abs(a[3] - b[3]);
    }
    e[k] = sum;
  }
  // A soft edge spreads over 2-4 pixels: the 3-tap sum peaks at its middle.
  const s = new Float64Array(n);
  for (let k = 0; k < n; k++) s[k] = e[k] + (e[k - 1] ?? 0) + (e[k + 1] ?? 0);
  return s;
}

/** Edge gain of a position: 0 below a faint share of the strongest edge, 1 from a clear share on; only local maxima count. */
function edgeGains(s: Float64Array): Float64Array {
  const maxima: number[] = [];
  for (let x = 1; x < s.length - 1; x++) if (s[x] >= s[x - 1] && s[x] > s[x + 1]) maxima.push(s[x]);
  maxima.sort((a, b) => a - b);
  // A few silhouette edges are far stronger than the rest: measure against a high percentile, not the maximum.
  const top = maxima[Math.floor(maxima.length * EDGE_REFERENCE)] || 1;
  const gain = new Float64Array(s.length);
  for (let x = 1; x < s.length - 1; x++)
    if (s[x] >= s[x - 1] && s[x] > s[x + 1])
      gain[x] = Math.min(1, Math.max(0, (s[x] / top - EDGE_FAINT) / (EDGE_CLEAR - EDGE_FAINT)));
  return gain;
}

interface Path {
  score: number;
  cuts: number[];
}

/**
 * Best chain of block boundaries for one nominal size: every boundary earns its edge gain minus a
 * small cost, and a block that is not `size` wide pays for the deviation, so boundaries sit on
 * edges where there are some and keep the lattice spacing in flat areas. Generated pixel art is a
 * lattice that drifts and jitters by up to half a block, so the chain is elastic (dynamic
 * programming over positions), not a rigid grid.
 */
function bestPath(gain: Float64Array, size: number): Path {
  const n = gain.length;
  const dev = Math.min(MAX_DEVIATION_PX, size * MAX_DEVIATION_SHARE);
  const lo = Math.max(1, Math.floor(size - dev));
  const hi = Math.ceil(size + dev);
  const f = new Float64Array(n + 1).fill(-Infinity);
  const prev = new Int32Array(n + 1).fill(-1);
  for (let x = 0; x <= n; x++) {
    // The first boundary may be anywhere in the first block: no stretch cost to reach it.
    let best = x < size ? 0 : -Infinity;
    let from = -1;
    for (let d = lo; d <= hi && d <= x; d++) {
      const v = f[x - d] - (STRETCH_COST * (d - size) * (d - size)) / (dev * dev);
      if (v > best) {
        best = v;
        from = x - d;
      }
    }
    if (best === -Infinity) continue;
    f[x] = best + (gain[x] ?? 0) - CUT_COST;
    prev[x] = from;
  }
  let end = -1;
  for (let x = Math.max(0, n - hi); x <= n; x++)
    if (f[x] > -Infinity && (end < 0 || f[x] > f[end])) end = x;
  const cuts: number[] = [];
  for (let x = end; x >= 0; x = prev[x]) cuts.push(x);
  return { score: f[end], cuts: cuts.reverse() };
}

/**
 * One nominal size for both axes (blocks are square; ponytail: a sprite stretched unevenly needs
 * the hint option per axis), the one whose boundary chains score best summed over x and y.
 */
function searchSize(
  gains: Float64Array[],
  lo: number,
  hi: number,
): { size: number; evidence: number } {
  const total = (size: number) => gains.reduce((a, g) => a + bestPath(g, size).score, 0);
  const coarse: { size: number; score: number }[] = [];
  for (let size = lo; size <= hi; size += SIZE_STEP) coarse.push({ size, score: total(size) });
  let best = coarse.reduce((a, b) => (b.score > a.score ? b : a));
  const sorted = coarse.map((c) => c.score).sort((a, b) => a - b);
  const evidence = best.score - sorted[sorted.length >> 1];
  // ponytail: with no clear lattice the best score is a coin toss between a size and its multiples; the finest size close to it is the safer guess. Ceiling: a flat curve at the wrong scale.
  if (evidence < WEAK_EVIDENCE)
    best = coarse.find((c) => c.score >= best.score - WEAK_SLACK * Math.abs(best.score)) ?? best;
  const centre = best.size;
  for (
    let size = Math.max(lo, centre - SIZE_FINE_SPAN);
    size <= centre + SIZE_FINE_SPAN;
    size += SIZE_FINE_STEP
  ) {
    const score = total(size);
    if (score > best.score) best = { size, score };
  }
  return { size: best.size, evidence };
}

/** Mean size, first-boundary offset and edge share of a cut list; the image ends close it. */
function axisFromCuts(found: number[], length: number, gain?: Float64Array): AxisGrid {
  const cuts = [...found];
  if (cuts[0] > 0) cuts.unshift(0);
  if (cuts[cuts.length - 1] < length) cuts.push(length);
  const inner = found.length > 1 ? found : cuts;
  const size = (inner[inner.length - 1] - inner[0]) / Math.max(1, inner.length - 1) || length;
  const onEdge = gain ? found.filter((c) => gain[c] > EDGE_ON).length / found.length : 0;
  return { size, offset: ((found[0] % size) + size) % size, confidence: onEdge, cuts };
}

/** A rigid lattice (for a grid the caller fixes by hand, and the negative control in the tests). */
export function lattice(size: number, offset: number, length: number): AxisGrid {
  const cuts: number[] = [];
  for (let t = offset; t < length; t += size) cuts.push(Math.round(t));
  return axisFromCuts(cuts, length);
}

export interface GridOptions {
  min?: number;
  max?: number;
  /** A known nominal block size (the owner's hint): only the boundaries are searched, not the size. */
  size?: number;
}

/** The block grid of an image, found from the colour-change edges. */
export function findGrid(img: Rgba, opt: GridOptions = {}): Grid {
  const profiles = [edgeProfile(img, 'x'), edgeProfile(img, 'y')];
  const gains = profiles.map(edgeGains);
  const found =
    opt.size === undefined
      ? searchSize(gains, opt.min ?? MIN_BLOCK, opt.max ?? MAX_BLOCK)
      : undefined;
  const size = opt.size ?? found!.size;
  const [x, y] = gains.map((g) => axisFromCuts(bestPath(g, size).cuts, g.length, g));
  return { x, y, evidence: found?.evidence ?? Infinity };
}

export interface Cells {
  cols: number;
  rows: number;
  /** cols * rows * 4 bytes RGBA; alpha 0 = background cell. */
  data: Uint8Array;
}

/** One colour per block: the dominant colour of its centre. Blocks cut off by the image edge are kept. */
export function sampleCells(img: Rgba, grid: Grid): Cells {
  const cols = grid.x.cuts.length - 1;
  const rows = grid.y.cuts.length - 1;
  const data = new Uint8Array(cols * rows * CHANNELS);
  const margin = (1 - INNER_SHARE) / 2;
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      const x0 = grid.x.cuts[cx];
      const y0 = grid.y.cuts[cy];
      // Clip to the image first, so a cut-off block is judged by what is inside.
      const xa = Math.max(0, x0);
      const xb = Math.min(img.width, grid.x.cuts[cx + 1]);
      const ya = Math.max(0, y0);
      const yb = Math.min(img.height, grid.y.cuts[cy + 1]);
      if (xb - xa < 1 || yb - ya < 1) continue;
      const px0 = Math.ceil(xa + (xb - xa) * margin);
      const px1 = Math.max(px0 + 1, Math.floor(xb - (xb - xa) * margin));
      const py0 = Math.ceil(ya + (yb - ya) * margin);
      const py1 = Math.max(py0 + 1, Math.floor(yb - (yb - ya) * margin));
      const buckets = new Map<number, { n: number; r: number; g: number; b: number }>();
      let total = 0;
      let opaque = 0;
      for (let y = py0; y < py1 && y < img.height; y++) {
        for (let x = px0; x < px1 && x < img.width; x++) {
          total++;
          const i = idx(img, x, y);
          if (img.data[i + 3] < BG_ALPHA) continue;
          opaque++;
          const key =
            ((img.data[i] / BUCKET) | 0) * 65536 +
            ((img.data[i + 1] / BUCKET) | 0) * 256 +
            ((img.data[i + 2] / BUCKET) | 0);
          const b = buckets.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
          b.n++;
          b.r += img.data[i];
          b.g += img.data[i + 1];
          b.b += img.data[i + 2];
          buckets.set(key, b);
        }
      }
      if (total === 0 || opaque / total < MIN_OPAQUE_SHARE) continue;
      let top = { n: 0, r: 0, g: 0, b: 0 };
      for (const b of buckets.values()) if (b.n > top.n) top = b;
      const o = (cy * cols + cx) * CHANNELS;
      data[o] = Math.round(top.r / top.n);
      data[o + 1] = Math.round(top.g / top.n);
      data[o + 2] = Math.round(top.b / top.n);
      data[o + 3] = OPAQUE;
    }
  }
  return { cols, rows, data };
}

/** Sample with a grid forced by the caller (for the negative control and for hand-fixed grids). */
export function snapWithGrid(img: Rgba, grid: Grid): Cells {
  const cells = sampleCells(img, grid);
  dropBorderBackground(cells);
  mergePalette(cells);
  return cells;
}

const near = (a: number[], b: number[], tol: number) =>
  Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) <= tol;

/**
 * An image without alpha (or with an opaque backdrop) has a border colour. When most border blocks
 * are opaque and the commonest one is near black or near white, blocks of that colour that touch the
 * border (flood fill) become transparent. Other opaque backdrops are left alone (ponytail: a coloured
 * backdrop is the owner's call, not guessed).
 */
export function dropBorderBackground(cells: Cells): boolean {
  const { cols, rows, data } = cells;
  const border: number[] = [];
  for (let x = 0; x < cols; x++) border.push(x, (rows - 1) * cols + x);
  for (let y = 0; y < rows; y++) border.push(y * cols, y * cols + cols - 1);
  const opaque = border.filter((c) => data[c * CHANNELS + 3] === OPAQUE);
  if (opaque.length / border.length < OPAQUE_BORDER_SHARE) return false;
  const counts = new Map<string, { n: number; rgb: number[] }>();
  for (const c of opaque) {
    const rgb = [data[c * 4], data[c * 4 + 1], data[c * 4 + 2]];
    const e = counts.get(rgb.join(',')) ?? { n: 0, rgb };
    e.n++;
    counts.set(rgb.join(','), e);
  }
  const main = [...counts.values()].sort((a, b) => b.n - a.n)[0].rgb;
  const dark = Math.max(...main) <= DARK_MAX;
  const light = Math.min(...main) >= LIGHT_MIN;
  if (!dark && !light) return false;
  const seen = new Uint8Array(cols * rows);
  const stack = opaque.filter((c) =>
    near([data[c * 4], data[c * 4 + 1], data[c * 4 + 2]], main, BORDER_TOLERANCE),
  );
  while (stack.length) {
    const c = stack.pop()!;
    if (seen[c]) continue;
    seen[c] = 1;
    const o = c * CHANNELS;
    if (
      data[o + 3] !== OPAQUE ||
      !near([data[o], data[o + 1], data[o + 2]], main, BORDER_TOLERANCE)
    )
      continue;
    data[o + 3] = 0;
    const x = c % cols;
    const y = (c / cols) | 0;
    if (x > 0) stack.push(c - 1);
    if (x < cols - 1) stack.push(c + 1);
    if (y > 0) stack.push(c - cols);
    if (y < rows - 1) stack.push(c + cols);
  }
  return true;
}

/** Colours closer than `distance` merge into the more common one (greedy, most common first). */
export function mergePalette(cells: Cells, distance = MERGE_DISTANCE): number {
  const counts = new Map<number, number>();
  const key = (o: number) => cells.data[o] * 65536 + cells.data[o + 1] * 256 + cells.data[o + 2];
  for (let o = 0; o < cells.data.length; o += CHANNELS)
    if (cells.data[o + 3]) counts.set(key(o), (counts.get(key(o)) ?? 0) + 1);
  const palette: number[][] = [];
  const target = new Map<number, number[]>();
  for (const [k] of [...counts].sort((a, b) => b[1] - a[1])) {
    const rgb = [(k >> 16) & 255, (k >> 8) & 255, k & 255];
    const hit = palette.find((p) => near(p, rgb, distance));
    if (hit) target.set(k, hit);
    else {
      palette.push(rgb);
      target.set(k, rgb);
    }
  }
  for (let o = 0; o < cells.data.length; o += CHANNELS) {
    if (!cells.data[o + 3]) continue;
    const t = target.get(key(o))!;
    cells.data[o] = t[0];
    cells.data[o + 1] = t[1];
    cells.data[o + 2] = t[2];
  }
  return palette.length;
}

export interface Figure {
  /** Position of the trimmed figure in the cell grid. */
  x: number;
  y: number;
  cells: Cells;
  /** Opaque cells in the figure. */
  count: number;
}

/** Connected figures (cells within FIGURE_GAP of each other), left to right, each trimmed to its box. */
export function extractFigures(src: Cells, gap = FIGURE_GAP): Figure[] {
  const { cols, rows, data } = src;
  const solid = (c: number) => data[c * CHANNELS + 3] >= PNG_ALPHA_THRESHOLD;
  const label = new Int32Array(cols * rows).fill(-1);
  const figures: Figure[] = [];
  for (let start = 0; start < cols * rows; start++) {
    if (!solid(start) || label[start] >= 0) continue;
    const id = figures.length;
    const members: number[] = [];
    const stack = [start];
    label[start] = id;
    while (stack.length) {
      const c = stack.pop()!;
      members.push(c);
      const cx = c % cols;
      const cy = (c / cols) | 0;
      for (let dy = -gap; dy <= gap; dy++) {
        for (let dx = -gap; dx <= gap; dx++) {
          const nx = cx + dx;
          const ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
          const n = ny * cols + nx;
          if (label[n] >= 0 || !solid(n)) continue;
          label[n] = id;
          stack.push(n);
        }
      }
    }
    if (members.length < MIN_FIGURE_CELLS) continue;
    const xs = members.map((c) => c % cols);
    const ys = members.map((c) => (c / cols) | 0);
    const x0 = Math.min(...xs);
    const y0 = Math.min(...ys);
    const w = Math.max(...xs) - x0 + 1;
    const h = Math.max(...ys) - y0 + 1;
    const out = new Uint8Array(w * h * CHANNELS);
    for (const c of members) {
      const o = ((((c / cols) | 0) - y0) * w + (c % cols) - x0) * CHANNELS;
      out.set(data.subarray(c * CHANNELS, c * CHANNELS + CHANNELS), o);
    }
    figures.push({ x: x0, y: y0, cells: { cols: w, rows: h, data: out }, count: members.length });
  }
  return figures.sort((a, b) => a.x - b.x || a.y - b.y);
}

export interface Fit {
  /** True-pixel size of the figure. */
  width: number;
  height: number;
  /** Tiles it covers at 1 art pixel = 1 game pixel (16 px tiles). */
  tilesW: number;
  tilesH: number;
  /** Game pixels left unused in the last tile row / column. */
  padW: number;
  padH: number;
  /** Scale that makes it fit one character frame (16x32): 1 = already fits, 0.5 = shrink by half. */
  charScale: number;
}

export function fitReport(width: number, height: number): Fit {
  const tilesW = Math.ceil(width / FLOOR_TILE_SIZE);
  const tilesH = Math.ceil(height / FLOOR_TILE_SIZE);
  return {
    width,
    height,
    tilesW,
    tilesH,
    padW: tilesW * FLOOR_TILE_SIZE - width,
    padH: tilesH * FLOOR_TILE_SIZE - height,
    charScale: Math.min(1, CHAR_FRAME_W / width, CHAR_FRAME_H / height),
  };
}

/** Everything in one call: grid, cells, figures. */
export function snap(img: Rgba, grid = findGrid(img)) {
  const cells = snapWithGrid(img, grid);
  return { grid, cells, figures: extractFigures(cells) };
}
