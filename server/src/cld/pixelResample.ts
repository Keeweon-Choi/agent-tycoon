/**
 * HD-CONVERT: generator art -> clean pixel art at a chosen pixel grid, shared by the HD sheet
 * converter (hdSheet.ts) and the parts importer's HD crop (partImport.ts). Pure over RGBA.
 *   detectGrid  the art's own pixel size and phase from where its colour edges fall (a comb that
 *               compares block borders with block middles, so a soft or noisy image still shows it)
 *   resample    per target pixel: drawn when the foreground covers a fair share of its block (not
 *               a majority: thin outlines and soft edges survive), in the block's dark outline
 *               colour where the source has a dark edge there, else its most common colour
 *   cleanup     one-pixel holes inside the silhouette filled, stray islands dropped, the
 *               silhouette's edge drawn in the outline colour where the source had one
 *   spriteStats what the owner sees as "empty dots": isolated pixels, holes, outline breaks, and
 *               the silhouette's overlap with a reference mask
 */
import type { Rgba } from './assetSnap.js';

export type IsBackground = (r: number, g: number, b: number, a: number) => boolean;

/** Pixels darker than this (Rec. 601 luma) are outline. */
export const DARK_LUMA = 72;
/** A target pixel is drawn when the foreground covers at least this share of its block. */
export const MIN_COVER = 0.3;
/** A block whose foreground is at least this share dark takes the dark (outline) colour. */
const DARK_SHARE = 0.34;
/** On the silhouette's edge, a block with at least this share of dark takes the outline colour. */
const EDGE_DARK_SHARE = 0.12;
/** Islands of at most this many pixels, apart from the figure, are strays. */
const STRAY_MAX = 2;
/** Grid search range (source pixels per art pixel), steps, and the comb's confidence bar. */
const GRID_STEP = 0.01;
const PHASE_STEP = 0.1;
/** A divisor of the best size wins when it scores this share of it; the size is refined this far
 *  around the winner in these steps. */
const DIVISOR_SHARE = 0.7;
/** Edge runs this many times the mean strength are borders; a border within this share of a block
 *  from the coarse grid joins the fit, which needs this many of them. */
const EDGE_PEAK = 2;
const FIT_SLACK = 0.25;
const MIN_FIT_POINTS = 8;
/** The share of a block's sides left out when its colour is taken. */
const INNER_MARGIN = 0.2;
/** A block with fewer clean centre pixels than this takes its centre pixel's colour. */
const CENTRE_BELOW = 16;
/** Colour buckets: 4 bits per channel. */
const BUCKET_SHIFT = 4;

const luma = (r: number, g: number, b: number) => r * 0.299 + g * 0.587 + b * 0.114;

export interface Grid {
  /** Source pixels per art pixel (square pixels). */
  size: number;
  /** Where the first block starts (source pixels, 0 <= ox < size). */
  ox: number;
  oy: number;
  /** How much brighter the edges are on block borders than in block middles (0: no grid). */
  confidence: number;
}

/** The colour-edge strength between columns (or rows) i-1 and i of a region, foreground only. */
function edges(img: Rgba, [x0, y0, x1, y1]: number[], vertical: boolean, isBg: IsBackground) {
  const L = vertical ? x1 - x0 : y1 - y0;
  const M = vertical ? y1 - y0 : x1 - x0;
  const e = new Float64Array(L);
  const at = (x: number, y: number) => (y * img.width + x) * 4;
  for (let l = 1; l < L; l++)
    for (let m = 0; m < M; m++) {
      const [x, y] = vertical ? [x0 + l, y0 + m] : [x0 + m, y0 + l];
      const [xa, ya] = vertical ? [x - 1, y] : [x, y - 1];
      const p = at(x, y);
      const q = at(xa, ya);
      const d = img.data;
      if (isBg(d[p], d[p + 1], d[p + 2], d[p + 3]) && isBg(d[q], d[q + 1], d[q + 2], d[q + 3]))
        continue;
      e[l] += Math.abs(d[p] - d[q]) + Math.abs(d[p + 1] - d[q + 1]) + Math.abs(d[p + 2] - d[q + 2]);
    }
  return e;
}

/** Edge strength at a fractional position (linear between the two columns). */
const at = (e: Float64Array, k: number) => {
  const i = Math.floor(k);
  const f = k - i;
  return (e[i] ?? 0) * (1 - f) + (e[i + 1] ?? 0) * f;
};

/** Comb score of block size `s`: the best phase's border-minus-middle edge strength, per mean. */
function comb(e: Float64Array, s: number, step = PHASE_STEP): { phase: number; score: number } {
  let mean = 0;
  for (const v of e) mean += v;
  mean /= Math.max(1, e.length);
  let best = { phase: 0, score: -Infinity };
  for (let p = 0; p < s; p += step) {
    let border = 0;
    let middle = 0;
    let n = 0;
    for (let k = p; k + s / 2 < e.length; k += s) {
      border += at(e, k);
      middle += at(e, k + s / 2);
      n++;
    }
    if (n < 3) continue;
    const score = (border - middle) / n / Math.max(1e-9, mean);
    if (score > best.score) best = { phase: p, score };
  }
  return best;
}

/** The art's own pixel grid in `region` [x0, y0, x1, y1): one square size, a phase per axis. A
 *  multiple of the true size fits its borders too, so a divisor that scores nearly as well wins;
 *  the winner is then refined on the borders themselves. */
export function detectGrid(
  img: Rgba,
  region: number[],
  isBg: IsBackground,
  range: { min: number; max: number } = { min: 3, max: 12 },
): Grid {
  const ex = edges(img, region, true, isBg);
  const ey = edges(img, region, false, isBg);
  const score = (s: number, step = PHASE_STEP): Grid => {
    const cx = comb(ex, s, step);
    const cy = comb(ey, s, step);
    return { size: s, ox: cx.phase, oy: cy.phase, confidence: (cx.score + cy.score) / 2 };
  };
  let best = score(range.min);
  for (let s = range.min; s <= range.max + 1e-9; s += GRID_STEP) {
    const g = score(s);
    if (g.confidence > best.confidence) best = g;
  }
  for (const d of [3, 2]) {
    const s = best.size / d;
    if (s < range.min) continue;
    const g = score(s);
    if (g.confidence >= best.confidence * DIVISOR_SHARE) {
      best = g;
      break;
    }
  }
  // the comb's peak is broad: fit the edges themselves (centroids of strong edge runs) to
  // phase + k * size by least squares, both axes sharing the size
  const peaks = (e: Float64Array) => {
    let mean = 0;
    for (const v of e) mean += v;
    mean /= Math.max(1, e.length);
    const out: number[] = [];
    for (let i = 0; i < e.length;) {
      if (e[i] <= mean * EDGE_PEAK) {
        i++;
        continue;
      }
      let [w, m] = [0, 0];
      for (; i < e.length && e[i] > mean * EDGE_PEAK; i++) [w, m] = [w + e[i], m + e[i] * i];
      out.push(m / w);
    }
    return out;
  };
  const fit = (g: Grid) => {
    const pts: { axis: 0 | 1; k: number; pos: number }[] = [];
    for (const [axis, e, ph] of [
      [0, ex, g.ox],
      [1, ey, g.oy],
    ] as const)
      for (const pos of peaks(e)) {
        const k = Math.round((pos - ph) / g.size);
        // only edges near a border of the coarse grid (a fill's soft gradient is not a border)
        if (Math.abs(pos - ph - k * g.size) <= g.size * FIT_SLACK) pts.push({ axis, k, pos });
      }
    if (pts.length < MIN_FIT_POINTS) return g;
    // pos = p_axis + k * s: normal equations for (s, px, py)
    let [skk, sk, n0, n1, sp0, sp1, skp] = [0, 0, 0, 0, 0, 0, 0];
    const kSum = [0, 0];
    for (const { axis, k, pos } of pts) {
      skk += k * k;
      skp += k * pos;
      kSum[axis] += k;
      if (axis === 0) [n0, sp0] = [n0 + 1, sp0 + pos];
      else [n1, sp1] = [n1 + 1, sp1 + pos];
      sk += k;
    }
    void sk;
    // s = (Σkp - Σk0·mean0 - Σk1·mean1) / (Σkk - Σk0²/n0 - Σk1²/n1)
    const m0 = n0 ? sp0 / n0 : 0;
    const m1 = n1 ? sp1 / n1 : 0;
    const den = skk - (n0 ? kSum[0] ** 2 / n0 : 0) - (n1 ? kSum[1] ** 2 / n1 : 0);
    if (den <= 0) return g;
    const size = (skp - kSum[0] * m0 - kSum[1] * m1) / den;
    const ox = n0 ? m0 - (kSum[0] / n0) * size : g.ox;
    const oy = n1 ? m1 - (kSum[1] / n1) * size : g.oy;
    const mod = (v: number) => ((v % size) + size) % size;
    return { size, ox: mod(ox), oy: mod(oy), confidence: g.confidence };
  };
  best = fit(fit(best));
  return best;
}

/** The phases that fit a given size best (when the size comes from elsewhere). */
export function phaseFor(img: Rgba, region: number[], isBg: IsBackground, size: number): Grid {
  const cx = comb(edges(img, region, true, isBg), size);
  const cy = comb(edges(img, region, false, isBg), size);
  return { size, ox: cx.phase, oy: cy.phase, confidence: (cx.score + cy.score) / 2 };
}

export interface Resampled {
  cols: number;
  rows: number;
  /** cols × rows RGBA. */
  data: Uint8Array;
  /** Per pixel: the foreground's share of its block, and the block's dark colour (or null). */
  cover: Float32Array;
  dark: (number[] | null)[];
}

/** The most common colour (4-bit buckets, averaged inside the winner) of a list of RGB triples. */
function mode(colours: number[][]): number[] {
  const buckets = new Map<number, { n: number; s: number[] }>();
  for (const c of colours) {
    const k =
      ((c[0] >> BUCKET_SHIFT) << 8) | ((c[1] >> BUCKET_SHIFT) << 4) | (c[2] >> BUCKET_SHIFT);
    const e = buckets.get(k) ?? { n: 0, s: [0, 0, 0] };
    e.n++;
    e.s = e.s.map((v, i) => v + c[i]);
    buckets.set(k, e);
  }
  let top = { n: 0, s: [0, 0, 0] };
  for (const e of buckets.values()) if (e.n > top.n) top = e;
  return top.s.map((v) => Math.round(v / top.n));
}

/** One block [x0, x1) × [y0, y1) of the source (pixels whose centres fall inside). */
export function sampleBlock(
  img: Rgba,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  isBg: IsBackground,
  clip?: number[],
) {
  const fg: number[][] = [];
  const inner: number[][] = [];
  const dark: number[][] = [];
  let total = 0;
  // the colour comes from the block's centre (its soft edges blend with the neighbours); the
  // cover and the dark share from all of it (a thin outline sits at a block's edge)
  const mx = (x1 - x0) * INNER_MARGIN;
  const my = (y1 - y0) * INNER_MARGIN;
  for (let y = Math.ceil(y0 - 0.5); y + 0.5 < y1; y++)
    for (let x = Math.ceil(x0 - 0.5); x + 0.5 < x1; x++) {
      if (x < 0 || y < 0 || x >= img.width || y >= img.height) continue;
      total++;
      const i = (y * img.width + x) * 4;
      const [r, g, b, a] = [img.data[i], img.data[i + 1], img.data[i + 2], img.data[i + 3]];
      // outside the clip (the figure's box) counts as background: a frame's border never comes in
      const outside = !!clip && (x < clip[0] || y < clip[1] || x >= clip[2] || y >= clip[3]);
      if (outside || isBg(r, g, b, a)) continue;
      fg.push([r, g, b]);
      if (x + 0.5 >= x0 + mx && x + 0.5 < x1 - mx && y + 0.5 >= y0 + my && y + 0.5 < y1 - my)
        inner.push([r, g, b]);
      if (luma(r, g, b) < DARK_LUMA) dark.push([r, g, b]);
    }
  const cover = total ? fg.length / total : 0;
  const darkShare = fg.length ? dark.length / fg.length : 0;
  const darkColour = dark.length ? mode(dark) : null;
  const pool = inner.length ? inner : fg;
  const light = pool.filter((c) => luma(c[0], c[1], c[2]) >= DARK_LUMA);
  // a small block's centre pixel is its least blended one: it wins over a mode of blends
  const cx = Math.min(img.width - 1, Math.max(0, Math.floor((x0 + x1) / 2)));
  const cy = Math.min(img.height - 1, Math.max(0, Math.floor((y0 + y1) / 2)));
  const ci = (cy * img.width + cx) * 4;
  const centre = [img.data[ci], img.data[ci + 1], img.data[ci + 2]];
  const centreOk =
    !isBg(centre[0], centre[1], centre[2], img.data[ci + 3]) &&
    !(clip && (cx < clip[0] || cy < clip[1] || cx >= clip[2] || cy >= clip[3])) &&
    luma(centre[0], centre[1], centre[2]) >= DARK_LUMA;
  const colour = !fg.length
    ? null
    : darkShare >= DARK_SHARE
      ? darkColour!
      : centreOk && light.length < CENTRE_BELOW
        ? centre
        : mode(light.length ? light : pool);
  return { cover, colour, darkShare, darkColour };
}

/** `cols × rows` art pixels of `grid` starting at block (c0, r0) of the region's origin. */
export function resample(
  img: Rgba,
  grid: Grid,
  origin: { x: number; y: number },
  cols: number,
  rows: number,
  isBg: IsBackground,
  opts: { minCover?: number; clip?: number[] } = {},
): Resampled {
  const minCover = opts.minCover ?? MIN_COVER;
  const data = new Uint8Array(cols * rows * 4);
  const cover = new Float32Array(cols * rows);
  const dark: (number[] | null)[] = new Array(cols * rows).fill(null);
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const x0 = origin.x + c * grid.size;
      const y0 = origin.y + r * grid.size;
      const s = sampleBlock(img, x0, y0, x0 + grid.size, y0 + grid.size, isBg, opts.clip);
      const i = r * cols + c;
      cover[i] = s.cover;
      dark[i] = s.darkShare >= EDGE_DARK_SHARE ? s.darkColour : null;
      if (s.cover >= minCover && s.colour) data.set([...s.colour, 255], i * 4);
    }
  return { cols, rows, data, cover, dark };
}

/** Holes filled, strays dropped, the outline closed: counts of each change. */
export function cleanup(img: Resampled): { holes: number; strays: number; outline: number } {
  const { cols, rows, data } = img;
  const on = (c: number, r: number) =>
    c >= 0 && r >= 0 && c < cols && r < rows && data[(r * cols + c) * 4 + 3] > 0;
  const n4 = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];
  let holes = 0;
  // a one-pixel hole: empty with all four neighbours drawn; it takes their most common colour
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      if (on(c, r) || !n4.every(([dx, dy]) => on(c + dx, r + dy))) continue;
      const colours = n4.map(([dx, dy]) => [
        ...data.subarray(((r + dy) * cols + c + dx) * 4, ((r + dy) * cols + c + dx) * 4 + 3),
      ]);
      data.set([...mode(colours), 255], (r * cols + c) * 4);
      holes++;
    }
  // stray islands: 8-connected pieces of at most STRAY_MAX pixels
  let strays = 0;
  const seen = new Uint8Array(cols * rows);
  for (let s = 0; s < cols * rows; s++) {
    if (seen[s] || !data[s * 4 + 3]) continue;
    const piece = [s];
    seen[s] = 1;
    for (let k = 0; k < piece.length; k++) {
      const [c, r] = [piece[k] % cols, Math.floor(piece[k] / cols)];
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const j = (r + dy) * cols + c + dx;
          if ((dx || dy) && on(c + dx, r + dy) && !seen[j]) {
            seen[j] = 1;
            piece.push(j);
          }
        }
    }
    if (piece.length <= STRAY_MAX)
      for (const j of piece) {
        data[j * 4 + 3] = 0;
        strays++;
      }
  }
  // the outline: a drawn edge pixel takes the dark colour its block had
  let outline = 0;
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      if (!on(c, r) || !img.dark[i]) continue;
      if (!n4.some(([dx, dy]) => !on(c + dx, r + dy))) continue;
      const o = i * 4;
      if (luma(data[o], data[o + 1], data[o + 2]) < DARK_LUMA) continue;
      data.set([...img.dark[i]!, 255], o);
      outline++;
    }
  return { holes, strays, outline };
}

export interface SpriteStats {
  opaque: number;
  /** Drawn pixels with no drawn 4-neighbour. */
  isolated: number;
  /** Empty pixels with all four neighbours drawn. */
  holes: number;
  /** Edge pixels of the silhouette that are not outline-dark. */
  outlineBreaks: number;
  /** Intersection over union with `ref` (drawn = 1), when given. */
  iou: number | null;
}

/** Counts for a w×h RGBA sprite (or a frame of it: region [x0, y0, x1, y1)). */
export function spriteStats(
  data: Uint8Array,
  w: number,
  region: number[],
  ref?: (x: number, y: number) => boolean,
): SpriteStats {
  const [x0, y0, x1, y1] = region;
  const on = (x: number, y: number) =>
    x >= x0 && y >= y0 && x < x1 && y < y1 && data[(y * w + x) * 4 + 3] > 0;
  const n4 = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];
  let opaque = 0;
  let isolated = 0;
  let holes = 0;
  let outlineBreaks = 0;
  let inter = 0;
  let union = 0;
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) {
      const drawn = on(x, y);
      const around = n4.filter(([dx, dy]) => on(x + dx, y + dy)).length;
      if (drawn) {
        opaque++;
        if (!around) isolated++;
        const o = (y * w + x) * 4;
        if (around < 4 && luma(data[o], data[o + 1], data[o + 2]) >= DARK_LUMA) outlineBreaks++;
      } else if (around === 4) holes++;
      if (ref) {
        const want = ref(x, y);
        if (want && drawn) inter++;
        if (want || drawn) union++;
      }
    }
  return { opaque, isolated, holes, outlineBreaks, iou: ref ? inter / Math.max(1, union) : null };
}
