/**
 * CHAR-FACTORY: a whole HD character sheet from a generator's labelled sheet (one magenta box per
 * frame, three rows: front, back, side), as the owner's first HD example came: each figure
 * resampled to HD pixels (pixelResample.ts: its own grid when it has one, foreground-share
 * sampling, outline kept, holes and strays cleaned), stood on the frame's floor and centred in a
 * 32×64 frame, and laid out as the HD char_N sheet (224×192, density 2; 3 and 4 give 48×96 and
 * 64×128 frames for the resolution study). Pure over decoded RGBA.
 */
import { mergePalette, type Rgba } from './assetSnap.js';
import {
  cleanup,
  detectGrid,
  type Grid,
  type IsBackground,
  phaseFor,
  resample,
} from './pixelResample.js';

/** The classic frame (16×32) and its floor: the feet end on row 30 (char_N; HD row 61). */
const CLASSIC_W = 16;
const CLASSIC_H = 32;
const CLASSIC_FLOOR = 30;
const FRAMES = 7;
const ROWS = 3;
const MAGENTA = [255, 0, 255];
const BG_DISTANCE = 100;
/** A frame box is a magenta region at least this large (the title and labels are smaller). */
const MIN_BOX_PIXELS = 10_000;
const ROW_SLACK = 40;
const MAGENTA_LEAD = 40;
/** A figure stands at most this many classic pixels tall (head on row 1, feet on the floor: 59 HD
 *  rows) and wide (30 HD columns). */
const FIGURE_CLASSIC_ROWS = 29.5;
const FIGURE_CLASSIC_COLS = 15;
/** The art's own grid is used when its comb stands this clear (else the fit size). */
const GRID_CONFIDENCE = 0.6;
const GRID_RANGE = { min: 3, max: 12 };
const dist = (a: ArrayLike<number>, b: readonly number[]) =>
  Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

export interface HdSheetResult {
  width: number;
  height: number;
  data: Uint8Array;
  report: {
    boxes: number;
    /** Source pixels per HD pixel, and whether that was the art's own grid (else the fit size). */
    size: number;
    gridFound: boolean;
    /** What the cleanup changed over all frames. */
    cleaned: { holes: number; strays: number; outline: number };
    /** Per row: which source box (1-based in its row) each of the 7 frames came from. */
    frames: number[][];
    /** Frames the source has no drawing for (filled from the standing frame). */
    missing: string[];
    /** Per row and frame: where its pixels came from in the source. */
    places: FigurePlace[][];
  };
}

/** The magenta boxes, top to bottom then left to right. */
export function boxes(img: Rgba): number[][] {
  const { width: W, height: H, data } = img;
  const mag = (i: number) =>
    data[i * 4 + 3] >= 128 && dist(data.subarray(i * 4, i * 4 + 3), MAGENTA) < BG_DISTANCE;
  const seen = new Uint8Array(W * H);
  const out: number[][] = [];
  for (let s = 0; s < W * H; s++) {
    if (seen[s] || !mag(s)) continue;
    const stack = [s];
    seen[s] = 1;
    let [n, x0, y0, x1, y1] = [0, W, H, 0, 0];
    while (stack.length) {
      const i = stack.pop()!;
      n++;
      const x = i % W;
      const y = (i / W) | 0;
      [x0, y0, x1, y1] = [Math.min(x0, x), Math.min(y0, y), Math.max(x1, x), Math.max(y1, y)];
      for (const j of [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, i - W, i + W])
        if (j >= 0 && j < W * H && !seen[j] && mag(j)) {
          seen[j] = 1;
          stack.push(j);
        }
    }
    if (n >= MIN_BOX_PIXELS) out.push([x0, y0, x1, y1]);
  }
  out.sort((a, b) => (Math.abs(a[1] - b[1]) > ROW_SLACK ? a[1] - b[1] : a[0] - b[0]));
  return regular(out);
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
/** The boxes on one grid: a box whose magenta leaked through a gap in its border into a label
 *  takes its row's top, its column's left and the common size. */
function regular(found: number[][]): number[][] {
  const perRow = Math.max(1, Math.round(found.length / 3));
  const row = (r: number) => found.filter((_, j) => Math.floor(j / perRow) === r);
  const col = (c: number) => found.filter((_, j) => j % perRow === c);
  return found.map((_, i) => {
    const [r, c] = [Math.floor(i / perRow), i % perRow];
    // a row shares its top and height, a column its left and width
    const y0 = median(row(r).map((b) => b[1]));
    const h = median(row(r).map((b) => b[3] - b[1]));
    const x0 = median(col(c).map((b) => b[0]));
    const w = median(col(c).map((b) => b[2] - b[0]));
    return [x0, y0, x0 + w, y0 + h];
  });
}

/** Magenta, or a colour the magenta bled into (red and blue both well above green). */
export const magentaish = (r: number, g: number, b: number, a: number) =>
  a < 128 ||
  dist([r, g, b], MAGENTA) < BG_DISTANCE ||
  (r - g > MAGENTA_LEAD && b - g > MAGENTA_LEAD);

/** The figure's bounding box inside a box: its largest foreground piece (the box's border, a
 *  label or a stray speck are smaller), in source pixels [x0, y0, x1, y1). */
export function figureOf(
  img: Rgba,
  [x0, y0, x1, y1]: number[],
  isBg: IsBackground = magentaish,
  /** The box holds no border (it was cut inside one): a piece touching its edge still counts. */
  borderless = false,
): number[] | null {
  const w = x1 - x0 + 1;
  const h = y1 - y0 + 1;
  const fg = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = ((y0 + y) * img.width + x0 + x) * 4;
      fg[y * w + x] = isBg(img.data[i], img.data[i + 1], img.data[i + 2], img.data[i + 3]) ? 0 : 1;
    }
  const seen = new Uint8Array(w * h);
  let best: number[] | null = null;
  let bestN = 0;
  for (let s = 0; s < w * h; s++) {
    if (!fg[s] || seen[s]) continue;
    const stack = [s];
    seen[s] = 1;
    let [n, bx0, by0, bx1, by1] = [0, w, h, -1, -1];
    while (stack.length) {
      const i = stack.pop()!;
      n++;
      const x = i % w;
      const y = (i / w) | 0;
      [bx0, by0, bx1, by1] = [
        Math.min(bx0, x),
        Math.min(by0, y),
        Math.max(bx1, x),
        Math.max(by1, y),
      ];
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          const j = yy * w + xx;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h || seen[j] || !fg[j]) continue;
          seen[j] = 1;
          stack.push(j);
        }
    }
    // the border ring runs along the whole box: never the figure
    const ring = !borderless && (bx0 === 0 || by0 === 0 || bx1 === w - 1 || by1 === h - 1);
    if (!ring && n > bestN) [best, bestN] = [[x0 + bx0, y0 + by0, x0 + bx1 + 1, y0 + by1 + 1], n];
  }
  return best;
}

/** Where a converted figure's pixels came from: its blocks of `grid.size` source pixels start at
 *  `origin`; block (c, r) lands on frame pixel (c + dx, r + dy), mirrored when `mirror`. */
export interface FigurePlace {
  grid: Grid;
  origin: { x: number; y: number };
  cols: number;
  rows: number;
  clip: number[];
  dx: number;
  dy: number;
  mirror: boolean;
}

/** Frame size, floor row and the figure's largest size at `density` pixels per classic pixel (the
 *  world size stays 16×32; the classic feet end on row 30). */
export const frameAt = (density: number) => ({
  w: CLASSIC_W * density,
  h: CLASSIC_H * density,
  floor: (CLASSIC_FLOOR + 1) * density - 1,
  figureRows: FIGURE_CLASSIC_ROWS * density,
  figureCols: FIGURE_CLASSIC_COLS * density,
});

/** The pixel size that stands figure `fig` (source pixels) in a frame at `density`. */
export const fitSize = (fig: number[], density: number) =>
  Math.max(
    (fig[3] - fig[1]) / frameAt(density).figureRows,
    (fig[2] - fig[0]) / frameAt(density).figureCols,
  );

/** One figure (`fig`, source pixels) resampled at `size` source pixels per pixel, cleaned, and stood
 *  on the floor of a frame at `density`, centred. */
export function figureFrame(
  img: Rgba,
  fig: number[],
  size: number,
  opts: {
    density?: number;
    isBg?: IsBackground;
    mirror?: boolean;
    minCover?: number;
    clean?: boolean;
    interiorDarkShare?: number;
  } = {},
):
  | { w: number; h: number; data: Uint8Array; place: FigurePlace; cleaned: Cleaned }
  | { error: string } {
  const isBg = opts.isBg ?? magentaish;
  const { w, h, floor } = frameAt(opts.density ?? 2);
  // the art's phase at that size; a ring of empty pixels around the figure
  const g = phaseFor(img, fig, isBg, size);
  const ox = fig[0] - ((((fig[0] - g.ox) % size) + size) % size) - size;
  const oy = fig[1] - ((((fig[1] - g.oy) % size) + size) % size) - size;
  const cols = Math.ceil((fig[2] - ox) / size) + 1;
  const rows = Math.ceil((fig[3] - oy) / size) + 1;
  const cells = resample(img, { ...g, size }, { x: ox, y: oy }, cols, rows, isBg, {
    clip: fig,
    ...(opts.minCover !== undefined && { minCover: opts.minCover }),
    ...(opts.interiorDarkShare !== undefined && { interiorDarkShare: opts.interiorDarkShare }),
  });
  const cleaned = opts.clean === false ? { holes: 0, strays: 0, outline: 0 } : cleanup(cells);
  let [fx0, fy0, fx1, fy1] = [cells.cols, cells.rows, -1, -1];
  for (let y = 0; y < cells.rows; y++)
    for (let x = 0; x < cells.cols; x++)
      if (cells.data[(y * cells.cols + x) * 4 + 3])
        [fx0, fy0, fx1, fy1] = [
          Math.min(fx0, x),
          Math.min(fy0, y),
          Math.max(fx1, x),
          Math.max(fy1, y),
        ];
  if (fx1 < 0) return { error: 'empty' };
  if (fx1 - fx0 + 1 > w || fy1 - fy0 + 1 > floor + 1)
    return { error: `the figure (${fx1 - fx0 + 1}×${fy1 - fy0 + 1}) does not fit ${w}×${h}` };
  // feet on the floor row, centred
  const dx = Math.round(w / 2 - (fx0 + fx1 + 1) / 2);
  const dy = floor - fy1;
  const data = new Uint8Array(w * h * 4);
  for (let y = fy0; y <= fy1; y++)
    for (let x = fx0; x <= fx1; x++) {
      const o = (y * cells.cols + x) * 4;
      if (!cells.data[o + 3]) continue;
      const tx = opts.mirror ? w - 1 - (x + dx) : x + dx;
      const ty = y + dy;
      if (tx < 0 || tx >= w || ty < 0 || ty >= h) continue;
      data.set([...cells.data.subarray(o, o + 3), 255], (ty * w + tx) * 4);
    }
  const place = { grid: { ...g, size }, origin: { x: ox, y: oy }, cols, rows, clip: fig, dx, dy };
  return { w, h, data, place: { ...place, mirror: !!opts.mirror }, cleaned };
}
type Cleaned = { holes: number; strays: number; outline: number };

/**
 * `pick[row]`: the source boxes (1-based in their row) for walk1, walk2, walk3; the seated frames
 * (type 1-2, read 1-2) repeat walk2, the standing frame, until they are drawn. `mirror[row]`: the
 * row is drawn facing the other way (the example's "우측면" looks left). `density`: 2 (32×64
 * frames, the default), 3 (48×96) or 4 (64×128).
 */
export function hdSheetFromBoxes(
  img: Rgba,
  opts: {
    pick?: number[][];
    mirror?: boolean[];
    density?: number;
    /** The share of a block the figure must cover, and whether to clean up (a reference mask: 0.5, no). */
    minCover?: number;
    clean?: boolean;
    interiorDarkShare?: number;
  } = {},
): HdSheetResult | { error: string } {
  const density = opts.density ?? 2;
  const found = boxes(img);
  if (found.length < ROWS * 3)
    return { error: `${found.length} frame boxes found, need 3 per row` };
  const perRow = Math.floor(found.length / ROWS);
  // one pixel size for the whole sheet (one generator, one scale): the art's own grid when it has
  // a clear one, else the size that stands the tallest figure in the frame (a generator's "pixel
  // art" is often smooth, with no grid to find)
  const figures = found.map((b) => figureOf(img, b));
  const grids = figures.map((f) => (f ? detectGrid(img, f, magentaish, GRID_RANGE) : null));
  const clear = grids.filter((g): g is Grid => !!g && g.confidence >= GRID_CONFIDENCE);
  const fit = Math.max(...figures.map((f) => (f ? fitSize(f, density) : 0)));
  const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  const grid = clear.length * 2 >= found.length ? median(clear.map((g) => g.size)) : fit;
  const size = Math.max(grid, fit); // never larger than the frame
  const pick = opts.pick ?? [
    [1, 2, 3],
    [1, 2, 3],
    [1, 2, 3],
  ];
  const { w: fw, h: fh } = frameAt(density);
  const width = fw * FRAMES;
  const height = fh * ROWS;
  const data = new Uint8Array(width * height * 4);
  const frames: number[][] = [];
  const places: FigurePlace[][] = [];
  const cleaned = { holes: 0, strays: 0, outline: 0 };
  for (let r = 0; r < ROWS; r++) {
    const src = [...pick[r], pick[r][1], pick[r][1], pick[r][1], pick[r][1]];
    frames.push(src);
    places.push([]);
    for (let f = 0; f < FRAMES; f++) {
      const box = found[r * perRow + src[f] - 1];
      if (!box) return { error: `row ${r + 1} has no box ${src[f]}` };
      const fig = figures[r * perRow + src[f] - 1];
      if (!fig) return { error: `row ${r + 1} box ${src[f]} is empty` };
      const one = figureFrame(img, fig, size, {
        density,
        mirror: !!opts.mirror?.[r],
        ...(opts.minCover !== undefined && { minCover: opts.minCover }),
        ...(opts.clean !== undefined && { clean: opts.clean }),
        ...(opts.interiorDarkShare !== undefined && { interiorDarkShare: opts.interiorDarkShare }),
      });
      if ('error' in one) return { error: `row ${r + 1} box ${src[f]}: ${one.error}` };
      cleaned.holes += one.cleaned.holes;
      cleaned.strays += one.cleaned.strays;
      cleaned.outline += one.cleaned.outline;
      places[r].push(one.place);
      for (let y = 0; y < fh; y++)
        data.set(
          one.data.subarray(y * fw * 4, (y + 1) * fw * 4),
          ((r * fh + y) * width + f * fw) * 4,
        );
    }
  }
  mergePalette({ cols: width, rows: height, data });
  const views = ['front', 'back', 'side'];
  return {
    width,
    height,
    data,
    report: {
      boxes: found.length,
      size,
      gridFound: clear.length * 2 >= found.length,
      cleaned,
      frames,
      places,
      missing: views.flatMap((v) => [`${v} type1`, `${v} type2`, `${v} read1`, `${v} read2`]),
    },
  };
}
