/**
 * RES-STUDY: which character resolution keeps the owner's detail (32×64, 48×96, 64×128). One
 * script, one section per study step, writing numbers and images under cld/artifacts/char-res/
 * (the Korean write-up is cld/docs/design/char-resolution.md).
 *
 *   npx tsx cld/scripts/res-study.ts source   step 1: each source's own pixel grid and real detail
 *   npx tsx cld/scripts/res-study.ts specs    step 2: the bunny at three specs, as parts, element by element
 *   node --expose-gc --import tsx cld/scripts/res-study.ts render   step 3: bytes, compose, cache, frame time
 */
import * as fs from 'fs';
import * as path from 'path';
import { PNG } from 'pngjs';

import { downsampleHd } from '../../core/src/cld/partData.js';
import type { Rgba } from '../../server/src/cld/assetSnap.js';
import { mergePalette } from '../../server/src/cld/assetSnap.js';
import {
  boxes,
  figureFrame,
  figureOf,
  type FigurePlace,
  fitSize,
  frameAt,
  hdSheetFromBoxes,
  magentaish,
} from '../../server/src/cld/hdSheet.js';
import { frameLines } from '../../server/src/cld/partImport.js';
import {
  detectGrid,
  type Grid,
  gridSpectrum,
  type IsBackground,
  phaseFor,
  spriteStats,
} from '../../server/src/cld/pixelResample.js';
import { launchBrowser } from '../../server/src/cld/testHome.js';

const root = path.resolve(__dirname, '../..');
const SRC_NEAR = path.join(root, '../specs/owner-art-1025');
const SOURCES = fs.existsSync(SRC_NEAR)
  ? SRC_NEAR
  : path.resolve(root, '.worktrees/specs/owner-art-1025');
const OUT = path.join(root, 'cld/artifacts/char-res');

export const read = (file: string): Rgba => {
  const p = PNG.sync.read(fs.readFileSync(file));
  return { width: p.width, height: p.height, data: new Uint8Array(p.data) };
};
export const write = (file: string, img: Rgba) => {
  const p = new PNG({ width: img.width, height: img.height });
  p.data = Buffer.from(img.data);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, PNG.sync.write(p));
};
const src = (name: string) => read(path.join(SOURCES, name));
const dist3 = (d: ArrayLike<number>, i: number, c: readonly number[]) =>
  Math.hypot(d[i] - c[0], d[i + 1] - c[1], d[i + 2] - c[2]);
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const round = (v: number, k = 2) => Math.round(v * 10 ** k) / 10 ** k;

/** A crop of `img` [x0, y0, x1, y1), enlarged `z` times (nearest). */
export function crop(img: Rgba, [x0, y0, x1, y1]: number[], z = 1): Rgba {
  const w = Math.round((x1 - x0) * z);
  const h = Math.round((y1 - y0) * z);
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const sx = Math.floor(x0 + x / z);
      const sy = Math.floor(y0 + y / z);
      if (sx < 0 || sy < 0 || sx >= img.width || sy >= img.height) continue;
      data.set(
        img.data.subarray((sy * img.width + sx) * 4, (sy * img.width + sx) * 4 + 4),
        (y * w + x) * 4,
      );
    }
  return { width: w, height: h, data };
}

/** Images side by side (top-aligned), `gap` pixels of `bg` between and around. */
export function row(imgs: Rgba[], gap = 8, bg = [24, 24, 32]): Rgba {
  const width = imgs.reduce((t, i) => t + i.width, 0) + gap * (imgs.length + 1);
  const height = Math.max(...imgs.map((i) => i.height)) + gap * 2;
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) data.set([...bg, 255], i * 4);
  let x = gap;
  for (const im of imgs) {
    for (let y = 0; y < im.height; y++)
      for (let xx = 0; xx < im.width; xx++) {
        const s = (y * im.width + xx) * 4;
        if (!im.data[s + 3]) continue;
        data.set(im.data.subarray(s, s + 4), ((y + gap) * width + x + xx) * 4);
      }
    x += im.width + gap;
  }
  return { width, height, data };
}
export const column = (imgs: Rgba[], gap = 8): Rgba => {
  const width = Math.max(...imgs.map((i) => i.width));
  const height = imgs.reduce((t, i) => t + i.height, 0) + gap * (imgs.length - 1);
  const data = new Uint8Array(width * height * 4);
  let y = 0;
  for (const im of imgs) {
    for (let yy = 0; yy < im.height; yy++)
      data.set(im.data.subarray(yy * im.width * 4, (yy + 1) * im.width * 4), (y + yy) * width * 4);
    y += im.height + gap;
  }
  return { width, height, data };
};

const GRID_DOT = 3;
/** The crop at `z` with the grid's block borders drawn over it (one bright line per border). */
function gridOverlay(img: Rgba, region: number[], g: Grid, z: number): Rgba {
  const out = crop(img, region, z);
  const mark = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= out.width || y >= out.height) return;
    // half-way to cyan: the art stays readable under a dense grid
    const o = (y * out.width + x) * 4;
    out.data.set(
      [out.data[o] >> 1, (out.data[o + 1] + 255) >> 1, (out.data[o + 2] + 255) >> 1, 255],
      o,
    );
  };
  for (let k = Math.ceil((region[0] - g.ox) / g.size); g.ox + k * g.size < region[2]; k++) {
    const x = Math.round((g.ox + k * g.size - region[0]) * z);
    for (let y = 0; y < out.height; y += GRID_DOT) mark(x, y);
  }
  for (let k = Math.ceil((region[1] - g.oy) / g.size); g.oy + k * g.size < region[3]; k++) {
    const y = Math.round((g.oy + k * g.size - region[1]) * z);
    for (let x = 0; x < out.width; x += GRID_DOT) mark(x, y);
  }
  return out;
}

/** Share of the figure's foreground pixels farther than BLUR_DISTANCE from their block's most
 *  common colour at grid `g`: 0 for clean pixel art blown up, high for a smooth painting. */
const BLUR_DISTANCE = 40;
function blurShare(img: Rgba, region: number[], g: Grid, isBg: IsBackground): number {
  const [x0, y0, x1, y1] = region;
  let off = 0;
  let n = 0;
  const k0x = Math.floor((x0 - g.ox) / g.size);
  const k0y = Math.floor((y0 - g.oy) / g.size);
  for (let by = k0y; g.oy + by * g.size < y1; by++)
    for (let bx = k0x; g.ox + bx * g.size < x1; bx++) {
      const px: number[] = [];
      for (let y = Math.ceil(g.oy + by * g.size - 0.5); y + 0.5 < g.oy + (by + 1) * g.size; y++)
        for (let x = Math.ceil(g.ox + bx * g.size - 0.5); x + 0.5 < g.ox + (bx + 1) * g.size; x++) {
          if (x < x0 || y < y0 || x >= x1 || y >= y1) continue;
          const i = (y * img.width + x) * 4;
          if (!isBg(img.data[i], img.data[i + 1], img.data[i + 2], img.data[i + 3])) px.push(i);
        }
      if (px.length < 2) continue;
      const buckets = new Map<number, number[]>();
      for (const i of px) {
        const key =
          ((img.data[i] >> 4) << 8) | ((img.data[i + 1] >> 4) << 4) | (img.data[i + 2] >> 4);
        buckets.set(key, [...(buckets.get(key) ?? []), i]);
      }
      const top = [...buckets.values()].sort((a, b) => b.length - a.length)[0];
      const c = [0, 1, 2].map((ch) => top.reduce((t, i) => t + img.data[i + ch], 0) / top.length);
      for (const i of px) if (dist3(img.data, i, c) > BLUR_DISTANCE) off++;
      n += px.length;
    }
  return n ? off / n : 0;
}

/** Share of foreground pixels with fewer than two 4-neighbours of (nearly) their own colour: a
 *  pixel-art image blown up by a whole factor has almost none, a soft painting most. */
const FLAT_DISTANCE = 10;
function softShare(img: Rgba, [x0, y0, x1, y1]: number[], isBg: IsBackground): number {
  let soft = 0;
  let n = 0;
  for (let y = y0 + 1; y < y1 - 1; y++)
    for (let x = x0 + 1; x < x1 - 1; x++) {
      const i = (y * img.width + x) * 4;
      if (isBg(img.data[i], img.data[i + 1], img.data[i + 2], img.data[i + 3])) continue;
      const c = [img.data[i], img.data[i + 1], img.data[i + 2]];
      let same = 0;
      for (const j of [i - 4, i + 4, i - img.width * 4, i + img.width * 4])
        if (dist3(img.data, j, c) <= FLAT_DISTANCE) same++;
      if (same < 2) soft++;
      n++;
    }
  return n ? soft / n : 0;
}

/** Runs of (nearly) one colour along the figure's rows and columns: a run ends where the next pixel
 *  differs by more than RUN_BREAK or is background. Runs of one or two pixels are blends (the
 *  generator's soft edges); the shortest real runs are the smallest drawn feature. */
const RUN_BREAK = 24;
const BLEND_RUN = 2;
const FEATURE_PERCENTILE = 0.1;
function runs(img: Rgba, [x0, y0, x1, y1]: number[], isBg: IsBackground) {
  const lengths: number[] = [];
  const bg = (x: number, y: number) => {
    const i = (y * img.width + x) * 4;
    return isBg(img.data[i], img.data[i + 1], img.data[i + 2], img.data[i + 3]);
  };
  const scan = (vertical: boolean) => {
    const [L, M] = vertical ? [x1 - x0, y1 - y0] : [y1 - y0, x1 - x0];
    for (let l = 0; l < L; l++) {
      let run = 0;
      let prev = -1;
      for (let m = 0; m <= M; m++) {
        const [x, y] = vertical ? [x0 + l, y0 + m] : [x0 + m, y0 + l];
        const inside = m < M && !bg(x, y);
        const i = (y * img.width + x) * 4;
        const cont =
          inside &&
          prev >= 0 &&
          dist3(img.data, i, [img.data[prev], img.data[prev + 1], img.data[prev + 2]]) <= RUN_BREAK;
        if (!cont && run) {
          lengths.push(run);
          run = 0;
        }
        if (inside) run++;
        prev = inside ? i : -1;
      }
    }
  };
  scan(false);
  scan(true);
  const pixels = lengths.reduce((t, v) => t + v, 0);
  const blend = lengths.filter((v) => v <= BLEND_RUN).reduce((t, v) => t + v, 0);
  const real = lengths.filter((v) => v > BLEND_RUN).sort((a, b) => a - b);
  return {
    blendShare: pixels ? blend / pixels : 0,
    feature: real.length ? real[Math.floor(real.length * FEATURE_PERCENTILE)] : 0,
    medianRun: real.length ? real[Math.floor(real.length / 2)] : 0,
  };
}

/** The comb's sizes for the spectra (source pixels per art pixel). */
const SPECTRUM_STEP = 0.05;
const spectrumSizes = (r: { min: number; max: number }) => {
  const out: number[] = [];
  for (let s = r.min; s <= r.max; s += SPECTRUM_STEP) out.push(round(s, 2));
  return out;
};
/** How far the best block size stands above the typical one (a grid: well above 2; none: near 1). */
function peakiness(img: Rgba, f: Figure): number {
  const sp = gridSpectrum(img, f.region, f.isBg, spectrumSizes(f.range)).filter(Number.isFinite);
  const pos = sp.map((v) => Math.max(0, v));
  return Math.max(...pos) / Math.max(1e-6, median(pos));
}

/** The art's grid in windows of WINDOW_UNITS classic pixels: a generator's grid drifts across a
 *  figure, so one comb over the whole figure smears; per window it stands out where there is one.
 *  Returns the windows whose comb is clear, their median size and how far they spread. */
const WINDOW_UNITS = 5;
const LOCAL_CONFIDENCE = 1;
/** Densities looked for: from the classic grid (1) to twice the 64×128 one (8). */
const LOCAL_MIN_DENSITY = 0.9;
const LOCAL_MAX_DENSITY = 8;
function localGrid(img: Rgba, region: number[], isBg: IsBackground, unit: number) {
  const win = Math.round(unit * WINDOW_UNITS);
  const sizes: number[] = [];
  let windows = 0;
  for (let y = region[1]; y + win / 2 < region[3]; y += win)
    for (let x = region[0]; x + win / 2 < region[2]; x += win) {
      const r = [x, y, Math.min(region[2], x + win), Math.min(region[3], y + win)];
      // the window must be mostly figure
      let fg = 0;
      for (let yy = r[1]; yy < r[3]; yy += 2)
        for (let xx = r[0]; xx < r[2]; xx += 2) {
          const i = (yy * img.width + xx) * 4;
          if (!isBg(img.data[i], img.data[i + 1], img.data[i + 2], img.data[i + 3])) fg++;
        }
      if (fg < ((r[2] - r[0]) * (r[3] - r[1])) / 4 / 3) continue;
      windows++;
      const g = detectGrid(img, r, isBg, {
        min: Math.max(1.5, unit / LOCAL_MAX_DENSITY),
        max: unit / LOCAL_MIN_DENSITY,
      });
      if (g.confidence >= LOCAL_CONFIDENCE) sizes.push(g.size);
    }
  const sorted = [...sizes].sort((a, b) => a - b);
  const q = (p: number) => (sorted.length ? sorted[Math.floor((sorted.length - 1) * p)] : 0);
  return {
    windows,
    clear: sizes.length,
    size: round(q(0.5)),
    spread: [round(q(0.25)), round(q(0.75))],
  };
}

/** A standing figure is 29.5 classic pixels tall (head row 1 to the feet on row 30). */
const FIGURE_CLASSIC_ROWS = 29.5;

interface Figure {
  source: string;
  label: string;
  region: number[];
  isBg: IsBackground;
  range: { min: number; max: number };
  /** A whole-region cut (a zoom panel): no figure to find, every pixel counts. */
  panel?: boolean;
  /** The template block (source pixels per classic pixel), for the part drawings. */
  block?: number;
}

/** The target image's cells (source pixels, measured on the image), per spec. */
const TARGET = {
  '32x64': {
    pose: [
      [44, 176, 196, 388],
      [207, 176, 368, 388],
      [379, 176, 532, 388],
    ],
    walk: [
      [45, 468, 165, 588],
      [174, 468, 284, 588],
      [294, 468, 405, 588],
      [414, 468, 532, 588],
    ],
    face: [44, 644, 340, 839],
    eye: [356, 655, 508, 822],
  },
  '48x96': {
    pose: [
      [598, 176, 752, 388],
      [762, 176, 918, 388],
      [929, 176, 1073, 388],
    ],
    walk: [
      [599, 468, 714, 590],
      [723, 468, 832, 590],
      [841, 468, 951, 590],
      [960, 468, 1073, 590],
    ],
    face: [598, 645, 890, 839],
    eye: [901, 655, 1057, 826],
  },
  '64x128': {
    pose: [
      [1138, 176, 1304, 449],
      [1315, 176, 1483, 449],
      [1494, 176, 1635, 449],
    ],
    walk: [
      [1138, 526, 1257, 636],
      [1265, 526, 1382, 636],
      [1390, 526, 1508, 636],
      [1516, 526, 1635, 636],
    ],
    face: [1138, 685, 1462, 844],
    eye: [1473, 690, 1630, 842],
  },
} as const;
export { TARGET };
const VIEWS = ['front', 'back', 'right'];
/** The cells are measured to their frame lines (2 px), cut just inside them. */
const INSET = 2;
const inset = ([x0, y0, x1, y1]: readonly number[]) => [
  x0 + INSET,
  y0 + INSET,
  x1 - INSET,
  y1 - INSET,
];

/** Background: within `d` of the colour most common on the box's border. */
function borderBg(img: Rgba, [x0, y0, x1, y1]: number[], d: number): IsBackground {
  const cs: number[][] = [];
  for (let x = x0; x < x1; x++)
    for (const y of [y0, y1 - 1])
      cs.push([...img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 3)]);
  for (let y = y0; y < y1; y++)
    for (const x of [x0, x1 - 1])
      cs.push([...img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 3)]);
  const c = [0, 1, 2].map((k) => median(cs.map((v) => v[k])));
  return (r, g, b, a) => a < 128 || Math.hypot(r - c[0], g - c[1], b - c[2]) < d;
}
/** The target's dark panels and their frame lines are blue-grey; the figure's darks (the suit, the
 *  ears, the outline) are neutral or warm, so the blue lead tells them apart. */
const TARGET_BLUE_LEAD = 10;
const TARGET_BG_LUMA = 100;
const targetBg: IsBackground = (r, g, b, a) =>
  a < 128 || (b - r >= TARGET_BLUE_LEAD && r * 0.299 + g * 0.587 + b * 0.114 < TARGET_BG_LUMA);
const SIAN_BG_DISTANCE = 24;
/** The design sheet's layout: a look's row is at least this tall; three characters (x ranges
 *  measured on it). */
const SIAN_MIN_ROW = 20;
const SIAN_GROUPS = [
  [5, 300],
  [315, 615],
  [625, 936],
];
/** A template cell (a sheet frame or the head canvas) is 16 classic pixels wide. */
const TEMPLATE_COLS = 16;
/** The part drawings: magenta, the green mannequin and the grey frame lines are not the owner's art. */
const notArt: IsBackground = (r, g, b, a) =>
  magentaish(r, g, b, a) || (g > 150 && r < 90 && b < 90) || (g > 100 && r < 40 && b < 40);

/** Every figure of every source. */
function figures(): { img: Map<string, Rgba>; list: Figure[] } {
  const img = new Map<string, Rgba>();
  const list: Figure[] = [];
  // the owner's HD bunny example: 21 magenta boxes
  const ex = src('hd-bunny-sheet-example.png');
  img.set('example', ex);
  boxes(ex).forEach((b, i) => {
    const f = figureOf(ex, b);
    if (f)
      list.push({
        source: 'example',
        label: `${VIEWS[Math.floor(i / 7)]} ${(i % 7) + 1}`,
        region: f,
        isBg: magentaish,
        range: { min: 2, max: 12 },
      });
  });
  // the target comparison: per spec, three poses, four walk frames, the two zoom cuts
  const tg = src('res-comparison-target.png');
  img.set('target', tg);
  for (const [spec, cells] of Object.entries(TARGET)) {
    const add = (label: string, cell: readonly number[], panel = false) => {
      const box = inset(cell);
      const isBg = targetBg;
      const f = panel ? box : figureOf(tg, box, isBg, true);
      if (f)
        list.push({
          source: `target ${spec}`,
          label,
          region: f,
          isBg: panel ? () => false : isBg,
          range: panel ? { min: 1.5, max: 16 } : { min: 1.5, max: 8 },
          panel,
        });
    };
    cells.pose.forEach((c, i) => add(VIEWS[i], c));
    cells.walk.forEach((c, i) => add(`walk ${i + 1}`, c));
    add('zoom face', cells.face, true);
    add('zoom eye', cells.eye, true);
  }
  // the design sheet: three characters × nine looks × three views on lavender
  const sian = src('sian-1025.png');
  img.set('sian', sian);
  const sianBg = borderBg(sian, [0, 0, sian.width, sian.height], SIAN_BG_DISTANCE);
  // looks (rows, from the background's empty bands across the sheet; the ears of one look reach
  // the row above, so two looks share a band) × three characters × three views: the figures touch,
  // so each is the largest piece of its cell
  const rowsY: number[][] = [];
  let start = -1;
  for (let y = 0; y <= sian.height; y++) {
    let fg = 0;
    if (y < sian.height)
      for (let x = 0; x < sian.width; x += 2) {
        const i = (y * sian.width + x) * 4;
        if (!sianBg(sian.data[i], sian.data[i + 1], sian.data[i + 2], sian.data[i + 3])) fg++;
      }
    if (fg > 2 && start < 0) start = y;
    if (fg <= 2 && start >= 0) {
      if (y - start > SIAN_MIN_ROW) rowsY.push([start, y]);
      start = -1;
    }
  }
  SIAN_GROUPS.forEach(([gx0, gx1], g) =>
    [0, 1, 2].forEach((v) => {
      const cw = (gx1 - gx0) / 3;
      rowsY.forEach(([y0, y1], r) => {
        const cell = [Math.round(gx0 + v * cw), y0, Math.round(gx0 + (v + 1) * cw) - 1, y1 - 1];
        const f = figureOf(sian, cell, sianBg, true);
        if (f)
          list.push({
            source: 'sian',
            label: `look ${r + 1} character ${g + 1} ${VIEWS[v]}`,
            region: f,
            isBg: sianBg,
            range: { min: 1.5, max: 12 },
          });
      });
    }),
  );
  // the five part drawings (the owner's art only: magenta, mannequin and lines left out)
  for (const name of [
    'top-bunny-f-down',
    'top-bunny-f-up',
    'top-bunny-f-right',
    'hair-bunnybob-f',
    'hair-bunnyface-f',
  ]) {
    const d = src(`${name}.png`);
    img.set(name, d);
    const v = frameLines(d, true);
    const h = frameLines(d, false);
    for (let c = 0; c + 1 < v.length; c++) {
      const cell = [
        Math.ceil(v[c]) + 3,
        Math.ceil(h[0]) + 3,
        Math.floor(v[c + 1]) - 3,
        Math.floor(h[h.length - 1]) - 3,
      ];
      const f = figureOf(d, cell, notArt);
      if (f)
        list.push({
          source: name,
          label: `cell ${c + 1}`,
          region: f,
          isBg: notArt,
          range: { min: 4, max: 40 },
          // the template's block: the cell is 16 classic pixels wide
          block: (v[c + 1] - v[c]) / TEMPLATE_COLS,
        });
    }
  }
  // calibration: a clean 32×64 sprite (our converted front frame) as a generator would hand it in,
  // blown up 4.73 times (the example's own scale) and softened by a 3×3 box blur
  const hd = read(path.join(root, 'cld/artifacts/hd-convert/after/bunny-hd-sample.png'));
  const cal = blownUp(crop(hd, [0, 0, 32, 64]), CAL_SCALE);
  img.set('calibration', cal);
  const fig = figureOf(cal, [0, 0, cal.width - 1, cal.height - 1], magentaish, true);
  if (fig)
    list.push({
      source: 'calibration',
      label: '32x64 x4.73 soft',
      region: fig,
      isBg: magentaish,
      range: { min: 2, max: 12 },
    });
  return { img, list };
}

const CAL_SCALE = 4.73;
/** A sprite on magenta, `k` times larger (nearest), then a 3×3 box blur. */
function blownUp(sprite: Rgba, k: number): Rgba {
  const pad = 20;
  const w = Math.round(sprite.width * k) + pad * 2;
  const h = Math.round(sprite.height * k) + pad * 2;
  const big = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const sx = Math.floor((x - pad) / k);
      const sy = Math.floor((y - pad) / k);
      const inside = sx >= 0 && sy >= 0 && sx < sprite.width && sy < sprite.height;
      const o = inside ? (sy * sprite.width + sx) * 4 : -1;
      big.set(
        o >= 0 && sprite.data[o + 3]
          ? [...sprite.data.subarray(o, o + 3), 255]
          : [255, 0, 255, 255],
        (y * w + x) * 4,
      );
    }
  const out = new Uint8Array(big);
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++)
      for (let c = 0; c < 3; c++) {
        let t = 0;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) t += big[((y + dy) * w + x + dx) * 4 + c];
        out[(y * w + x) * 4 + c] = Math.round(t / 9);
      }
  return { width: w, height: h, data: out };
}

function source() {
  fs.rmSync(path.join(OUT, 'source'), { recursive: true, force: true });
  const { img, list } = figures();
  const rows: Record<string, unknown>[] = [];
  for (const f of list) {
    const im = img.get(f.source.startsWith('target') ? 'target' : f.source)!;
    const g = detectGrid(im, f.region, f.isBg, f.range);
    const [w, h] = [f.region[2] - f.region[0], f.region[3] - f.region[1]];
    // source pixels per classic pixel: the template's block, or the figure's height over 29.5
    const unit = f.block ?? h / FIGURE_CLASSIC_ROWS;
    rows.push({
      source: f.source,
      label: f.label,
      region: f.region,
      span: [w, h],
      grid: {
        size: round(g.size),
        ox: round(g.ox, 1),
        oy: round(g.oy, 1),
        confidence: round(g.confidence),
      },
      realPixels: [round(w / g.size, 1), round(h / g.size, 1)],
      blurShare: round(blurShare(im, f.region, g, f.isBg)),
      softShare: round(softShare(im, f.region, f.isBg)),
      ...(() => {
        const r = runs(im, f.region, f.isBg);
        const u = f.block ?? h / FIGURE_CLASSIC_ROWS;
        // the smallest drawn feature, in pixels per classic pixel: the density the art is drawn at
        return {
          blendShare: round(r.blendShare),
          feature: r.feature,
          medianRun: r.medianRun,
          featureDensity: round(u / r.feature, 1),
        };
      })(),
      peak: round(peakiness(im, f)),
      ...(f.block ? { templateBlock: round(f.block) } : {}),
      ...(f.panel
        ? {}
        : {
            unit: round(unit),
            local: localGrid(im, f.region, f.isBg, unit),
          }),
    });
  }
  // a summary per source: medians
  const by = new Map<string, Record<string, unknown>[]>();
  for (const r of rows) {
    const label = String(r.label);
    const kind = label.startsWith('zoom') ? ` ${label}` : label.startsWith('walk') ? ' walk' : '';
    const k = `${r.source}${kind}`;
    by.set(k, [...(by.get(k) ?? []), r]);
  }
  const summary = [...by.entries()].map(([k, rs]) => {
    const g = (f: (r: any) => number) => round(median(rs.map(f)));
    return {
      source: k,
      figures: rs.length,
      gridSize: g((r) => r.grid.size),
      confidence: g((r) => r.grid.confidence),
      spanPx: [g((r) => r.span[0]), g((r) => r.span[1])],
      realPixels: [g((r) => r.realPixels[0]), g((r) => r.realPixels[1])],
      blurShare: g((r) => r.blurShare),
      softShare: g((r) => r.softShare),
      blendShare: g((r) => r.blendShare),
      feature: g((r) => r.feature),
      featureDensity: g((r) => r.featureDensity),
      peak: g((r) => r.peak),
      ...(rs[0].templateBlock ? { templateBlock: g((r) => r.templateBlock) } : {}),
      ...(rs[0].local
        ? {
            unit: g((r) => r.unit),
            localClear: `${rs.reduce((t, r: any) => t + r.local.clear, 0)}/${rs.reduce((t, r: any) => t + r.local.windows, 0)}`,
            localSize: g((r) => r.local.size),
            localDensity: g((r) => (r.local.size ? r.unit / r.local.size : 0)),
          }
        : {}),
    };
  });
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(
    path.join(OUT, 'source-grid.json'),
    JSON.stringify({ summary, figures: rows }, null, 2) + '\n',
  );
  console.table(
    summary.map((s) => ({ ...s, spanPx: String(s.spanPx), realPixels: String(s.realPixels) })),
  );
  // evidence: each source's head with the pixel grid of each spec drawn over it (32×64, 48×96,
  // 64×128 from left): how many target pixels an eye or a strand gets
  const show = (key: string, label: string, z: number, file: string) => {
    const f = list.find((x) => x.source === key && x.label === label)!;
    const im = img.get(key.startsWith('target') ? 'target' : key)!;
    const [x0, y0, x1, y1] = f.region;
    const unit = f.block ?? (y1 - y0) / FIGURE_CLASSIC_ROWS;
    // the head canvas: the top 12 classic rows of a figure, the top 16 of a head drawing
    const part = [
      x0,
      y0,
      x1,
      Math.round(y0 + unit * (f.block && key.startsWith('hair') ? 16 : 12)),
    ];
    const overlays = [2, 3, 4].map((d) =>
      gridOverlay(im, part, phaseFor(im, f.region, f.isBg, unit / d), z),
    );
    write(path.join(OUT, 'source', file), row(overlays));
  };
  show('example', 'front 1', 3, 'example-head-specs.png');
  for (const s of Object.keys(TARGET))
    show(`target ${s}`, 'front', 3, `target-${s}-head-specs.png`);
  show('sian', 'look 1 character 1 front', 4, 'sian-char1-head-specs.png');
  show('hair-bunnyface-f', 'cell 1', 1, 'hair-bunnyface-head-specs.png');
  show('calibration', '32x64 x4.73 soft', 3, 'calibration-head-specs.png');
}

// ---- step 2: the bunny at 32×64, 48×96 and 64×128, as parts ----------------------------------

const PARTS = ['body', 'face', 'hair', 'suit', 'tights', 'heels', 'tail'] as const;
type PartName = (typeof PARTS)[number];
/** A colour per part for the label maps. */
const PART_COLOURS: Record<PartName, number[]> = {
  body: [240, 190, 150],
  face: [230, 60, 60],
  hair: [120, 200, 255],
  suit: [60, 60, 200],
  tights: [140, 100, 60],
  heels: [250, 230, 40],
  tail: [80, 240, 120],
};
const DENSITIES = [2, 3, 4] as const;
/** The converter change measured: inside the silhouette, dark wins from this share. */
const INTERIOR_DARK = 0.5;
const SPEC_NAME: Record<number, string> = { 2: '32x64', 3: '48x96', 4: '64x128' };
type View = 'front' | 'back' | 'side';
const luma = (r: number, g: number, b: number) => r * 0.299 + g * 0.587 + b * 0.114;

/** The figure's height bands (share of its height from the top): the head (ears to chin), the
 *  torso to the hips, the legs; hair falls this far over the shoulders; the tail's band. */
const BAND = {
  ears: 0.22,
  head: 0.46,
  hairEnd: 0.52,
  tightsFrom: 0.6,
  legs: 0.64,
  suitEnd: 0.72,
  heels: 0.9,
};
const SUIT_CENTRE = 0.2;
const BARE_LEG_LUMA = 170;
/** Dark material: at least this share of the (2r+1)² around a dark pixel is dark too. */
const MATERIAL_RADIUS = 2;
const MATERIAL_SHARE = 0.6;
const OUTLINE_REACH = 2;
const OUTLINE_PASSES = 4;
const TAIL_BAND = [0.52, 0.72];
const CENTRE = 0.18;
const TAIL_CENTRE = 0.22;
/** Colour classes: skin is warm and bright, light is the silver hair and the white trims. */
const isSkin = (r: number, g: number, b: number) =>
  r > 140 && r - g >= 12 && g >= b && r - b >= 35 && luma(r, g, b) > 110;
const isLight = (r: number, g: number, b: number) =>
  luma(r, g, b) >= 150 && Math.max(r, g, b) - Math.min(r, g, b) <= 40;
/** The suit's black (with its sheen) and the heels: darker than the tights' mesh. */
const isDark = (r: number, g: number, b: number) => luma(r, g, b) < DARK_SUIT;
const DARK_SUIT = 80;
/** The fringe covers the top of the face box: the eyes and mouth lie below this share of it. */
const FRINGE = 0.35;

/** Each foreground pixel of a standing bunny figure labelled with its part (an index into PARTS,
 *  -1 for background): colour classes within the figure's height bands. `back` is the side the
 *  tail is on in a side view (the figure faces the other way). */
function labelFigure(
  img: Rgba,
  fig: number[],
  view: View,
  isBg: IsBackground,
  back: 'left' | 'right' = 'right',
) {
  const [x0, y0, x1, y1] = fig;
  const W = x1 - x0;
  const H = y1 - y0;
  const labels = new Int8Array(W * H).fill(-1);
  const px = (x: number, y: number) =>
    img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4);
  // the face: where the skin is inside the head band
  let [fx0, fy0, fx1, fy1] = [x1, y1, x0, y0];
  for (let y = y0; y < y0 + H * BAND.head; y++)
    for (let x = x0; x < x1; x++) {
      const [r, g, b, a] = px(x, y);
      if (!isBg(r, g, b, a) && isSkin(r, g, b))
        [fx0, fy0, fx1, fy1] = [
          Math.min(fx0, x),
          Math.min(fy0, y),
          Math.max(fx1, x),
          Math.max(fy1, y),
        ];
    }
  const inFace = (x: number, y: number) =>
    view !== 'back' && x >= fx0 && x <= fx1 && y >= fy0 && y <= fy1;
  const id = (p: PartName) => PARTS.indexOf(p);
  const dark = (x: number, y: number) => {
    if (x < x0 || y < y0 || x >= x1 || y >= y1) return false;
    const [r, g, b, a] = px(x, y);
    return !isBg(r, g, b, a) && isDark(r, g, b);
  };
  // a dark pixel is material (the suit, the ears, the heels) where the dark around it is wide, else
  // it is an outline and belongs to what it outlines
  const material = (x: number, y: number) => {
    let n = 0;
    for (let dy = -MATERIAL_RADIUS; dy <= MATERIAL_RADIUS; dy++)
      for (let dx = -MATERIAL_RADIUS; dx <= MATERIAL_RADIUS; dx++) if (dark(x + dx, y + dy)) n++;
    return n >= (2 * MATERIAL_RADIUS + 1) ** 2 * MATERIAL_SHARE;
  };
  const outlines: number[] = [];
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) {
      const [r, g, b, a] = px(x, y);
      if (isBg(r, g, b, a)) continue;
      const t = (y - y0) / H;
      const u = (x - x0) / W;
      const off = Math.abs(u - 0.5);
      // through sheer tights the legs read warm too: bare skin there is bright
      const skin = isSkin(r, g, b) && (t < BAND.tightsFrom || luma(r, g, b) > BARE_LEG_LUMA);
      const light = isLight(r, g, b);
      const isDarkPx = isDark(r, g, b);
      const onTailSide =
        view === 'back'
          ? off < TAIL_CENTRE
          : view === 'side' && (back === 'right' ? u > 0.5 : u < 0.5);
      const below = y > fy0 + (fy1 - fy0) * FRINGE;
      let part: PartName | null;
      if (t < BAND.head) {
        if (skin) part = 'body';
        else if (inFace(x, y) && (below || !light)) part = isDarkPx && !below ? null : 'face';
        else part = isDarkPx && t > BAND.ears && !material(x, y) ? null : 'hair';
      } else if (skin) part = 'body';
      else if (light && view !== 'front' && onTailSide && t >= TAIL_BAND[0] && t < TAIL_BAND[1])
        part = 'tail';
      else if (light && t < BAND.hairEnd && (view === 'back' || off > CENTRE)) part = 'hair';
      else if (isDarkPx && !material(x, y)) part = null;
      else if (isDarkPx && t >= BAND.heels) part = 'heels';
      else if (isDarkPx && t < BAND.suitEnd && (t < BAND.legs || off < SUIT_CENTRE)) part = 'suit';
      else if (light) part = 'suit';
      else part = t < BAND.tightsFrom ? 'suit' : 'tights';
      if (part) labels[(y - y0) * W + (x - x0)] = id(part);
      else outlines.push(x, y);
    }
  // outlines: the most common part within OUTLINE_REACH (several passes, so thick outlines fill)
  for (let pass = 0; pass < OUTLINE_PASSES && outlines.length; pass++) {
    const left: number[] = [];
    const set: [number, number][] = [];
    for (let k = 0; k < outlines.length; k += 2) {
      const [x, y] = [outlines[k], outlines[k + 1]];
      const votes = new Array(PARTS.length).fill(0);
      for (let dy = -OUTLINE_REACH; dy <= OUTLINE_REACH; dy++)
        for (let dx = -OUTLINE_REACH; dx <= OUTLINE_REACH; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx < x0 || yy < y0 || xx >= x1 || yy >= y1) continue;
          const l = labels[(yy - y0) * W + (xx - x0)];
          if (l >= 0) votes[l]++;
        }
      const best = Math.max(...votes);
      if (best) set.push([(y - y0) * W + (x - x0), votes.indexOf(best)]);
      else left.push(x, y);
    }
    for (const [i, l] of set) labels[i] = l;
    outlines.splice(0, outlines.length, ...left);
  }
  return {
    labels,
    W,
    H,
    at: (x: number, y: number) =>
      x < x0 || y < y0 || x >= x1 || y >= y1 ? -1 : labels[(y - y0) * W + (x - x0)],
  };
}

/** Per pixel of a converted frame, the part most of its source block belongs to (a pixel the
 *  cleanup filled takes its neighbours' part). */
function frameLabels(
  f: { w: number; h: number; data: Uint8Array },
  place: FigurePlace,
  at: (x: number, y: number) => number,
) {
  const out = new Int8Array(f.w * f.h).fill(-1);
  const s = place.grid.size;
  for (let ty = 0; ty < f.h; ty++)
    for (let tx = 0; tx < f.w; tx++) {
      if (!f.data[(ty * f.w + tx) * 4 + 3]) continue;
      const x = place.mirror ? f.w - 1 - tx : tx;
      const bx = place.origin.x + (x - place.dx) * s;
      const by = place.origin.y + (ty - place.dy) * s;
      const votes = new Array(PARTS.length).fill(0);
      for (let y = Math.ceil(by - 0.5); y + 0.5 < by + s; y++)
        for (let xx = Math.ceil(bx - 0.5); xx + 0.5 < bx + s; xx++) {
          const l = at(xx, y);
          if (l >= 0) votes[l]++;
        }
      const best = votes.indexOf(Math.max(...votes));
      out[ty * f.w + tx] = votes[best] ? best : -2;
    }
  for (let pass = 0; pass < 3; pass++)
    for (let i = 0; i < out.length; i++) {
      if (out[i] !== -2) continue;
      const [x, y] = [i % f.w, Math.floor(i / f.w)];
      const votes = new Array(PARTS.length).fill(0);
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const j = (y + dy) * f.w + x + dx;
          if (x + dx >= 0 && x + dx < f.w && y + dy >= 0 && y + dy < f.h && out[j] >= 0)
            votes[out[j]]++;
        }
      if (Math.max(...votes)) out[i] = votes.indexOf(Math.max(...votes));
    }
  return out;
}

/** The part's own mask at the frame's grid: a pixel where the part covers half its source block. */
function partReference(
  f: { w: number; h: number },
  place: FigurePlace,
  at: (x: number, y: number) => number,
  part: number,
) {
  const s = place.grid.size;
  return (tx: number, ty: number) => {
    const x = place.mirror ? f.w - 1 - tx : tx;
    const bx = place.origin.x + (x - place.dx) * s;
    const by = place.origin.y + (ty - place.dy) * s;
    let n = 0;
    let on = 0;
    for (let y = Math.ceil(by - 0.5); y + 0.5 < by + s; y++)
      for (let xx = Math.ceil(bx - 0.5); xx + 0.5 < bx + s; xx++) {
        n++;
        if (at(xx, y) === part) on++;
      }
    return n > 0 && on * 2 >= n;
  };
}

/** A frame's pixels of one part only. */
const layer = (
  f: { w: number; h: number; data: Uint8Array },
  labels: Int8Array,
  part: number,
): Rgba => {
  const data = new Uint8Array(f.data.length);
  for (let i = 0; i < labels.length; i++)
    if (labels[i] === part) data.set(f.data.subarray(i * 4, i * 4 + 4), i * 4);
  return { width: f.w, height: f.h, data };
};
const flipX = (img: Rgba): Rgba => {
  const data = new Uint8Array(img.data.length);
  for (let y = 0; y < img.height; y++)
    for (let x = 0; x < img.width; x++)
      data.set(
        img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4),
        (y * img.width + img.width - 1 - x) * 4,
      );
  return { width: img.width, height: img.height, data };
};
/** Transparent pixels shown on a dark checker, so a crop reads like the office floor. */
const onDark = (img: Rgba, cell = 6): Rgba => {
  const data = new Uint8Array(img.data);
  for (let i = 0; i < img.width * img.height; i++) {
    if (data[i * 4 + 3]) continue;
    const [x, y] = [i % img.width, Math.floor(i / img.width)];
    const c = (Math.floor(x / cell) + Math.floor(y / cell)) % 2 ? 44 : 36;
    data.set([c, c, c + 8, 255], i * 4);
  }
  return { width: img.width, height: img.height, data };
};

interface Converted {
  d: number;
  frame: { w: number; h: number; data: Uint8Array };
  place: FigurePlace;
  labels: Int8Array;
}
interface Subject {
  name: string;
  view: View;
  img: Rgba;
  fig: number[];
  isBg: IsBackground;
  label: ReturnType<typeof labelFigure>;
  specs: Converted[];
}

/** The bunny subjects: the owner's HD example (front, back, side walk 1) and the target image's
 *  64×128 poses (the largest it draws), each converted at every density on its own grid. */
function subjects(): Subject[] {
  const out: Subject[] = [];
  const ex = src('hd-bunny-sheet-example.png');
  const sheets = DENSITIES.map((d) => {
    const r = hdSheetFromBoxes(ex, { density: d, mirror: [false, false, true] });
    if ('error' in r) throw new Error(r.error);
    return { d, r };
  });
  for (const d of DENSITIES) {
    const r = sheets.find((x) => x.d === d)!.r;
    write(path.join(OUT, 'specs', `example-sheet-${SPEC_NAME[d]}.png`), {
      width: r.width,
      height: r.height,
      data: r.data,
    });
  }
  (['front', 'back', 'side'] as View[]).forEach((view, row) => {
    const place0 = sheets[0].r.report.places[row][0];
    const label = labelFigure(ex, place0.clip, view, magentaish, 'right');
    const specs = sheets.map(({ d, r }) => {
      const place = r.report.places[row][0];
      const { w, h } = frameAt(d);
      const data = new Uint8Array(w * h * 4);
      for (let y = 0; y < h; y++)
        data.set(
          r.data.subarray((row * h + y) * r.width * 4, ((row * h + y) * r.width + w) * 4),
          y * w * 4,
        );
      const frame = { w, h, data };
      return { d, frame, place, labels: frameLabels(frame, place, label.at) };
    });
    out.push({ name: 'example', view, img: ex, fig: place0.clip, isBg: magentaish, label, specs });
  });
  const tg = src('res-comparison-target.png');
  TARGET['64x128'].pose.forEach((cell, i) => {
    const view = (['front', 'back', 'side'] as View[])[i];
    const fig = figureOf(tg, inset(cell), targetBg, true)!;
    const label = labelFigure(tg, fig, view, targetBg, 'left');
    const specs = DENSITIES.map((d) => {
      const one = figureFrame(tg, fig, fitSize(fig, d), { density: d, isBg: targetBg });
      if ('error' in one) throw new Error(one.error);
      mergePalette({ cols: one.w, rows: one.h, data: one.data });
      return { d, frame: one, place: one.place, labels: frameLabels(one, one.place, label.at) };
    });
    out.push({ name: 'target64', view, img: tg, fig, isBg: targetBg, label, specs });
  });
  return out;
}

/** Display scale: screen pixels per classic pixel for element crops and for whole figures. */
const ELEMENT_SCALE = 24;
const FIGURE_SCALE = 12;
const ELEMENT_PAD = 1;
/** The office's usual zoom (screen pixels per classic pixel) and the target's stated cut zoom. */
const OFFICE_ZOOM = 4;
/** Heights (share of the figure from the top) where the silhouette's width is measured. */
const SILHOUETTE_ROWS = { chest: 0.47, waist: 0.55, hips: 0.62, thighs: 0.72 };
const PORTRAIT_ZOOM = 4;

/** The element boxes (classic pixels of the frame) from the parts the finest spec found. */
function elementBoxes(sub: Subject): Record<string, number[]> {
  const fine = sub.specs[sub.specs.length - 1];
  const box = (parts: PartName[], pad = ELEMENT_PAD) => {
    let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
    const ids = parts.map((p) => PARTS.indexOf(p));
    for (let i = 0; i < fine.labels.length; i++) {
      if (!ids.includes(fine.labels[i])) continue;
      const [x, y] = [i % fine.frame.w, Math.floor(i / fine.frame.w)];
      [x0, y0, x1, y1] = [
        Math.min(x0, x),
        Math.min(y0, y),
        Math.max(x1, x + 1),
        Math.max(y1, y + 1),
      ];
    }
    if (x0 === Infinity) return null;
    const d = fine.d;
    return [
      Math.max(0, Math.floor(x0 / d) - pad),
      Math.max(0, Math.floor(y0 / d) - pad),
      Math.min(16, Math.ceil(x1 / d) + pad),
      Math.min(32, Math.ceil(y1 / d) + pad),
    ];
  };
  const out: Record<string, number[] | null> = { figure: [0, 0, 16, 32] };
  if (sub.view === 'front') {
    out.face = box(['face']);
    out.head = box(['hair', 'face']);
    out.torso = box(['suit']);
    out.legs = box(['tights', 'heels']);
  }
  if (sub.view === 'back') {
    out.tail = box(['tail'], 2);
    out.head = box(['hair']);
  }
  if (sub.view === 'side') out.legs = box(['tights', 'heels']);
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v)) as Record<string, number[]>;
}

/** The source under a box of classic frame pixels, at `scale` screen pixels per classic pixel. */
function sourceCrop(sub: Subject, box: number[], scale: number): Rgba {
  const c = sub.specs[sub.specs.length - 1];
  const { d, place } = c;
  const s = place.grid.size;
  // frame pixel (tx, ty) of density d starts at source origin + (tx - dx, ty - dy) * s (unmirrored)
  const tx0 = place.mirror ? c.frame.w - box[2] * d : box[0] * d;
  const sx0 = place.origin.x + (tx0 - place.dx) * s;
  const sy0 = place.origin.y + (box[1] * d - place.dy) * s;
  const sx1 = sx0 + (box[2] - box[0]) * d * s;
  const sy1 = sy0 + (box[3] - box[1]) * d * s;
  const z = scale / (d * s);
  const out = crop(sub.img, [sx0, sy0, sx1, sy1], z);
  // the source's background (and anything outside the figure) as transparent, like the sprites
  for (let i = 0; i < out.width * out.height; i++) {
    const o = i * 4;
    const x = sx0 + (i % out.width) / z;
    const y = sy0 + Math.floor(i / out.width) / z;
    const [cx0, cy0, cx1, cy1] = place.clip;
    const outside = x < cx0 || y < cy0 || x >= cx1 || y >= cy1;
    if (outside || sub.isBg(out.data[o], out.data[o + 1], out.data[o + 2], out.data[o + 3]))
      out.data[o + 3] = 0;
  }
  return place.mirror ? flipX(out) : out;
}

/** Edges: a luma step of at least EDGE_STEP between neighbours (background counts as black). An
 *  element keeps the source's edge where the spec, drawn back at the source's scale, has an edge
 *  within EDGE_REACH source pixel: the share kept is its edge recall (a lash or a strand that
 *  merges into its neighbour, or an edge moved to the next block border, is lost). */
const EDGE_STEP = 40;
const EDGE_REACH = 1;
function edgeRecall(sub: Subject, c: Converted, box: number[]): number {
  const s = c.place.grid.size;
  const [cx0, cy0, cx1, cy1] = c.place.clip;
  // the element in source pixels (the box is in classic frame pixels)
  const tx0 = c.place.mirror ? c.frame.w - box[2] * c.d : box[0] * c.d;
  const sx0 = Math.max(cx0, Math.floor(c.place.origin.x + (tx0 - c.place.dx) * s));
  const sy0 = Math.max(cy0, Math.floor(c.place.origin.y + (box[1] * c.d - c.place.dy) * s));
  const sx1 = Math.min(cx1, Math.ceil(sx0 + (box[2] - box[0]) * c.d * s));
  const sy1 = Math.min(cy1, Math.ceil(sy0 + (box[3] - box[1]) * c.d * s));
  const W = sx1 - sx0;
  const H = sy1 - sy0;
  const srcL = new Float32Array(W * H);
  const specL = new Float32Array(W * H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = ((sy0 + y) * sub.img.width + sx0 + x) * 4;
      const d = sub.img.data;
      srcL[y * W + x] = sub.isBg(d[i], d[i + 1], d[i + 2], d[i + 3])
        ? 0
        : luma(d[i], d[i + 1], d[i + 2]);
      // the spec pixel over this source pixel
      const fx = Math.floor((sx0 + x - c.place.origin.x) / s) + c.place.dx;
      const fy = Math.floor((sy0 + y - c.place.origin.y) / s) + c.place.dy;
      const tx = c.place.mirror ? c.frame.w - 1 - fx : fx;
      const o = (fy * c.frame.w + tx) * 4;
      const inside = tx >= 0 && fy >= 0 && tx < c.frame.w && fy < c.frame.h && c.frame.data[o + 3];
      specL[y * W + x] = inside
        ? luma(c.frame.data[o], c.frame.data[o + 1], c.frame.data[o + 2])
        : 0;
    }
  const edge = (L: Float32Array) => {
    const e = new Uint8Array(W * H);
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const v = L[y * W + x];
        if (
          (x + 1 < W && Math.abs(L[y * W + x + 1] - v) >= EDGE_STEP) ||
          (y + 1 < H && Math.abs(L[(y + 1) * W + x] - v) >= EDGE_STEP)
        )
          e[y * W + x] = 1;
      }
    return e;
  };
  const se = edge(srcL);
  const pe = edge(specL);
  let n = 0;
  let kept = 0;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      if (!se[y * W + x]) continue;
      n++;
      let hit = false;
      for (let dy = -EDGE_REACH; dy <= EDGE_REACH && !hit; dy++)
        for (let dx = -EDGE_REACH; dx <= EDGE_REACH && !hit; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx >= 0 && yy >= 0 && xx < W && yy < H && pe[yy * W + xx]) hit = true;
        }
      if (hit) kept++;
    }
  return n ? kept / n : 1;
}

/** The eyes of a front or side subject: the face's two largest dark pieces (iris and lashes), and
 *  the light dots inside them (the highlights), in source pixels and in each spec's pixels. */
const EYE_DARK = 120;
const HIGHLIGHT = 200;
function eyes(sub: Subject) {
  const { W, H, labels } = sub.label;
  const [x0, y0] = sub.fig;
  const face = PARTS.indexOf('face');
  const lum = (x: number, y: number) => {
    const i = ((y0 + y) * sub.img.width + x0 + x) * 4;
    return luma(sub.img.data[i], sub.img.data[i + 1], sub.img.data[i + 2]);
  };
  const pieces = (want: (x: number, y: number) => boolean) => {
    const seen = new Uint8Array(W * H);
    const out: number[][] = [];
    for (let s0 = 0; s0 < W * H; s0++) {
      if (seen[s0] || !want(s0 % W, Math.floor(s0 / W))) continue;
      const stack = [s0];
      seen[s0] = 1;
      let [n, bx0, by0, bx1, by1] = [0, W, H, 0, 0];
      while (stack.length) {
        const i = stack.pop()!;
        const [x, y] = [i % W, Math.floor(i / W)];
        n++;
        [bx0, by0, bx1, by1] = [
          Math.min(bx0, x),
          Math.min(by0, y),
          Math.max(bx1, x + 1),
          Math.max(by1, y + 1),
        ];
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const [xx, yy] = [x + dx, y + dy];
            const j = yy * W + xx;
            if (xx >= 0 && yy >= 0 && xx < W && yy < H && !seen[j] && want(xx, yy)) {
              seen[j] = 1;
              stack.push(j);
            }
          }
      }
      out.push([n, bx0, by0, bx1, by1]);
    }
    return out.sort((a, b) => b[0] - a[0]);
  };
  const eyeBoxes = pieces((x, y) => labels[y * W + x] === face && lum(x, y) < EYE_DARK).slice(
    0,
    sub.view === 'side' ? 1 : 2,
  );
  const highlights = eyeBoxes.flatMap(([, ex0, ey0, ex1, ey1]) =>
    pieces((x, y) => x >= ex0 && x < ex1 && y >= ey0 && y < ey1 && lum(x, y) > HIGHLIGHT).slice(
      0,
      1,
    ),
  );
  const size = (b: number[]) => [b[3] - b[1], b[4] - b[2]];
  const per = (px: number[]) =>
    Object.fromEntries(
      sub.specs.map((c) => [SPEC_NAME[c.d], px.map((v) => round(v / c.place.grid.size, 1))]),
    );
  return {
    eye: eyeBoxes.map((b) => ({ source: size(b), specs: per(size(b)) })),
    highlight: highlights.map((b) => ({ source: size(b), specs: per(size(b)) })),
  };
}

function specs() {
  fs.rmSync(path.join(OUT, 'specs'), { recursive: true, force: true });
  fs.rmSync(path.join(OUT, 'portraits'), { recursive: true, force: true });
  const subs = subjects();
  const metrics: Record<string, unknown>[] = [];
  for (const sub of subs) {
    const tag = `${sub.name}-${sub.view}`;
    // the source's labels, as a picture
    const lab: Rgba = {
      width: sub.label.W,
      height: sub.label.H,
      data: new Uint8Array(sub.label.W * sub.label.H * 4),
    };
    sub.label.labels.forEach(
      (l, i) => l >= 0 && lab.data.set([...PART_COLOURS[PARTS[l]], 255], i * 4),
    );
    const srcFig = crop(sub.img, sub.fig, 1);
    for (let i = 0; i < srcFig.width * srcFig.height; i++)
      if (sub.isBg(srcFig.data[i * 4], srcFig.data[i * 4 + 1], srcFig.data[i * 4 + 2], 255))
        srcFig.data[i * 4 + 3] = 0;
    write(path.join(OUT, 'specs', `${tag}-labels.png`), row([onDark(srcFig), onDark(lab)]));
    for (const c of sub.specs) {
      const ref = (part: number) => partReference(c.frame, c.place, sub.label.at, part);
      const whole = spriteStats(c.frame.data, c.frame.w, [0, 0, c.frame.w, c.frame.h]);
      const parts = Object.fromEntries(
        PARTS.map((p, i) => {
          const l = layer(c.frame, c.labels, i);
          const st = spriteStats(l.data, l.width, [0, 0, l.width, l.height], ref(i));
          return [
            p,
            {
              pixels: st.opaque,
              isolated: st.isolated,
              holes: st.holes,
              iou: st.iou === null ? null : round(st.iou),
            },
          ];
        }).filter(([, v]) => (v as { pixels: number }).pixels > 0),
      );
      const colours = new Set<number>();
      for (let i = 0; i < c.frame.w * c.frame.h; i++)
        if (c.frame.data[i * 4 + 3])
          colours.add(
            (c.frame.data[i * 4] << 16) | (c.frame.data[i * 4 + 1] << 8) | c.frame.data[i * 4 + 2],
          );
      metrics.push({
        subject: tag,
        spec: SPEC_NAME[c.d],
        sourcePxPerPixel: round(c.place.grid.size),
        pixels: whole.opaque,
        colours: colours.size,
        isolated: whole.isolated,
        holes: whole.holes,
        outlineBreaks: whole.outlineBreaks,
        parts,
      });
      // the parts, one layer each, beside the whole frame (in-office checker behind)
      const z = FIGURE_SCALE / c.d;
      const layers = [
        c.frame as unknown as Rgba,
        ...PARTS.map((_, i) => layer(c.frame, c.labels, i)),
      ].map((l) =>
        onDark(
          crop(
            { width: c.frame.w, height: c.frame.h, data: (l as Rgba).data ?? c.frame.data },
            [0, 0, c.frame.w, c.frame.h],
            z,
          ),
        ),
      );
      write(path.join(OUT, 'specs', `${tag}-parts-${SPEC_NAME[c.d]}.png`), row(layers));
    }
    // the elements: source | 32×64 | 48×96 | 64×128, at one world size
    for (const [el, box] of Object.entries(elementBoxes(sub))) {
      const scale = el === 'figure' ? FIGURE_SCALE : ELEMENT_SCALE;
      const cells = [
        onDark(sourceCrop(sub, box, scale)),
        ...sub.specs.map((c) =>
          onDark(
            crop(
              { width: c.frame.w, height: c.frame.h, data: c.frame.data },
              box.map((v) => v * c.d),
              scale / c.d,
            ),
          ),
        ),
      ];
      write(path.join(OUT, 'specs', `${tag}-${el}.png`), row(cells));
    }
  }
  // the converter change on the eyes: today's dark rule (a block a third dark takes the outline
  // colour) against a majority rule inside the silhouette; per spec, now then changed
  const front = subs.find((x) => x.name === 'example' && x.view === 'front')!;
  const faceBox = elementBoxes(front).face;
  const ex = front.img;
  const cells: Rgba[] = [onDark(sourceCrop(front, faceBox, ELEMENT_SCALE))];
  const changed: Record<string, unknown> = {};
  for (const d of DENSITIES) {
    const now = front.specs.find((c) => c.d === d)!;
    const r = hdSheetFromBoxes(ex, {
      density: d,
      mirror: [false, false, true],
      interiorDarkShare: INTERIOR_DARK,
    });
    if ('error' in r) throw new Error(r.error);
    const { w, h } = frameAt(d);
    const frame = { w, h, data: new Uint8Array(w * h * 4) };
    for (let y = 0; y < h; y++)
      frame.data.set(r.data.subarray(y * r.width * 4, (y * r.width + w) * 4), y * w * 4);
    const show = (f: { w: number; h: number; data: Uint8Array }) =>
      onDark(
        crop(
          { width: f.w, height: f.h, data: f.data },
          faceBox.map((v) => v * d),
          ELEMENT_SCALE / d,
        ),
      );
    cells.push(show(now.frame), show(frame));
    const c2 = { ...now, frame, place: r.report.places[0][0] };
    changed[SPEC_NAME[d]] = {
      now: round(edgeRecall(front, now, faceBox)),
      changed: round(edgeRecall(front, c2, faceBox)),
    };
  }
  write(path.join(OUT, 'specs', 'converter-eyes.png'), row(cells));
  console.log('face edge recall, now vs interior majority', JSON.stringify(changed));

  // portraits: the target's 4× zoom cuts, as the portrait the owner wants, beside the in-office
  // sprite of that spec (our conversion of the target's 64×128 figure, at office zoom) and beside
  // that sprite's own head blown up to the portrait's scale: what a portrait must carry on its own
  const tg = src('res-comparison-target.png');
  const tFront = subs.find((x) => x.name === 'target64' && x.view === 'front')!;
  const portraits: Record<string, unknown> = {};
  for (const c of tFront.specs) {
    const spec = SPEC_NAME[c.d];
    const cut = inset(TARGET[spec as keyof typeof TARGET].face);
    const portrait = crop(tg, cut, 1);
    const office = onDark(
      crop(
        { width: c.frame.w, height: c.frame.h, data: c.frame.data },
        [0, 0, c.frame.w, c.frame.h],
        OFFICE_ZOOM / c.d,
      ),
    );
    const head = elementBoxes(tFront).head.map((v) => v * c.d);
    const blown = onDark(
      crop({ width: c.frame.w, height: c.frame.h, data: c.frame.data }, head, PORTRAIT_ZOOM),
    );
    write(path.join(OUT, 'portraits', `portrait-${spec}.png`), row([portrait, office, blown]));
    // the face's width: the widest row of skin in the cut (in cut pixels, then per the stated 4×)
    // against the sprite's own face width in its pixels
    const skinWidth = (img: Rgba, region: number[]) => {
      let best = 0;
      for (let y = region[1]; y < region[3]; y++) {
        let [l, r] = [Infinity, -Infinity];
        for (let x = region[0]; x < region[2]; x++) {
          const i = (y * img.width + x) * 4;
          if (img.data[i + 3] && isSkin(img.data[i], img.data[i + 1], img.data[i + 2]))
            [l, r] = [Math.min(l, x), Math.max(r, x)];
        }
        if (r > l) best = Math.max(best, r - l + 1);
      }
      return best;
    };
    const fb = elementBoxes(tFront).face.map((v) => v * c.d);
    const spriteFace = skinWidth({ width: c.frame.w, height: c.frame.h, data: c.frame.data }, fb);
    const cutFace = skinWidth(tg, cut) / PORTRAIT_ZOOM;
    portraits[spec] = {
      cutFaceWidthAt4x: round(cutFace, 1),
      spriteFaceWidth: spriteFace,
      ratio: round(cutFace / Math.max(1, spriteFace), 1),
    };
  }
  console.log('portraits', JSON.stringify(portraits));

  // the silhouette: its width (source pixels) at the chest, waist, hips and thighs, in the source
  // and per spec (the spec's pixels times its block size), measured as the drawn span of the row
  const silhouette: Record<string, unknown> = {};
  for (const sub of subs.filter((x) => x.view === 'front')) {
    const [x0, y0, x1, y1] = sub.fig;
    const span = (on: (x: number) => boolean, from: number, to: number) => {
      let [l, r] = [Infinity, -Infinity];
      for (let x = from; x < to; x++) if (on(x)) [l, r] = [Math.min(l, x), Math.max(r, x)];
      return r >= l ? r - l + 1 : 0;
    };
    const rows: Record<string, unknown> = {};
    for (const [name, t] of Object.entries(SILHOUETTE_ROWS)) {
      const y = Math.round(y0 + (y1 - y0) * t);
      const srcW = span(
        (x) => {
          const i = (y * sub.img.width + x) * 4;
          return !sub.isBg(
            sub.img.data[i],
            sub.img.data[i + 1],
            sub.img.data[i + 2],
            sub.img.data[i + 3],
          );
        },
        x0,
        x1,
      );
      rows[name] = {
        source: srcW,
        ...Object.fromEntries(
          sub.specs.map((c) => {
            const fy = Math.floor((y - c.place.origin.y) / c.place.grid.size) + c.place.dy;
            const w = span((x) => !!c.frame.data[(fy * c.frame.w + x) * 4 + 3], 0, c.frame.w);
            return [SPEC_NAME[c.d], round((w * c.place.grid.size) / Math.max(1, srcW))];
          }),
        ),
      };
    }
    silhouette[sub.name] = rows;
  }
  console.log('silhouette', JSON.stringify(silhouette));

  // the design sheet: one figure (look 2, the first character, front) at each spec, to show what a
  // 160-180 px figure can give (it is smaller than the example's 274 px)
  {
    const { img: imgs, list } = figures();
    const f = list.find((x) => x.label === 'look 2 character 1 front')!;
    const sian = imgs.get('sian')!;
    const frames = DENSITIES.map((d) => {
      const one = figureFrame(sian, f.region, fitSize(f.region, d), { density: d, isBg: f.isBg });
      if ('error' in one) throw new Error(one.error);
      mergePalette({ cols: one.w, rows: one.h, data: one.data });
      return { d, one };
    });
    const srcCrop = crop(
      sian,
      f.region,
      (FIGURE_SCALE * FIGURE_CLASSIC_ROWS) / (f.region[3] - f.region[1]),
    );
    for (let i = 0; i < srcCrop.width * srcCrop.height; i++)
      if (f.isBg(srcCrop.data[i * 4], srcCrop.data[i * 4 + 1], srcCrop.data[i * 4 + 2], 255))
        srcCrop.data[i * 4 + 3] = 0;
    write(
      path.join(OUT, 'specs', 'sian-look2-front-figure.png'),
      row([
        onDark(srcCrop),
        ...frames.map(({ d, one }) =>
          onDark(
            crop(
              { width: one.w, height: one.h, data: one.data },
              [0, 0, one.w, one.h],
              FIGURE_SCALE / d,
            ),
          ),
        ),
      ]),
    );
    console.log(
      'sian figure px per pixel',
      frames.map(({ d, one }) => [SPEC_NAME[d], round(one.place.grid.size)]),
    );
  }

  // edge recall per element and spec
  const recall: Record<string, Record<string, number>> = {};
  for (const sub of subs)
    for (const [el, box] of Object.entries(elementBoxes(sub)))
      recall[`${sub.name}-${sub.view}-${el}`] = Object.fromEntries(
        sub.specs.map((c) => [SPEC_NAME[c.d], round(edgeRecall(sub, c, box))]),
      );
  console.table(recall);
  const eyeSizes = Object.fromEntries(
    subs.filter((x) => x.view !== 'back').map((x) => [`${x.name}-${x.view}`, eyes(x)]),
  );
  console.log(JSON.stringify(eyeSizes));
  fs.writeFileSync(
    path.join(OUT, 'specs-metrics.json'),
    JSON.stringify(
      {
        frames: metrics,
        edgeRecall: recall,
        eyes: eyeSizes,
        portraits,
        silhouette,
        interiorDark: { share: INTERIOR_DARK, faceEdgeRecall: changed },
      },
      null,
      2,
    ) + '\n',
  );
  console.table(
    metrics.map((m) => ({
      ...m,
      parts: Object.entries(m.parts as Record<string, { iou: number }>)
        .map(([k, v]) => `${k}:${v.iou}`)
        .join(' '),
    })),
  );
}

// ---- step 3: rendering and coexistence ------------------------------------------------------

/** An RGBA sheet as rrggbb strings ('' transparent), and back. */
const hexAt = (img: Rgba) => (x: number, y: number) => {
  if (x < 0 || y < 0 || x >= img.width || y >= img.height) return '';
  const o = (y * img.width + x) * 4;
  return img.data[o + 3]
    ? [0, 1, 2].map((k) => img.data[o + k].toString(16).padStart(2, '0')).join('')
    : '';
};
function fromHex(w: number, h: number, get: (x: number, y: number) => string): Rgba {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const c = get(x, y);
      if (c)
        data.set(
          [0, 2, 4].map((i) => parseInt(c.slice(i, i + 2), 16)).concat(255),
          (y * w + x) * 4,
        );
    }
  return { width: w, height: h, data };
}
/** The next copy down the chain (2×2, the colour most of the four share, outline kept). */
const halve = (img: Rgba) => fromHex(img.width / 2, img.height / 2, downsampleHd(hexAt(img)));

/** Office zooms looked at, and the frame-time run. */
const ZOOMS = [1, 2, 3, 4, 5, 6, 8];
const BENCH_CHARACTERS = 20;
const BENCH_FRAMES = 300;
const BENCH_CANVAS = { w: 1280, h: 800 };
const BENCH_ZOOM = 4;
/** The floor behind the characters in the benchmark and the zoom pictures. */
const FLOOR_RGB = [38, 38, 46];
/** Layers a person is made of (body, face, hair, top, bottom, shoes, outer, acc) and the share of
 *  a layer's pixels it draws, for the compose estimate. */
const COMPOSE_LAYERS = 8;
const LAYER_FILL = 0.3;

/** The compositor's paint loop (webview parts.ts paint, the sheet kind) at density d. */
function composeLoop(d: number, layers: string[][], palette: string[]) {
  const w = 112 * d;
  const h = 96 * d;
  const flat: string[] = new Array(w * h).fill('');
  for (const pixels of layers)
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const k = pixels[y * w + x];
        if (k !== '.') flat[y * w + x] = palette[k.charCodeAt(0) % palette.length];
      }
  // the sheet as frames of rows (SpriteData)
  const frames: string[][][] = [];
  for (let v = 0; v < 3; v++)
    for (let f = 0; f < 7; f++)
      frames.push(
        Array.from({ length: 32 * d }, (_, y) =>
          Array.from({ length: 16 * d }, (_, x) => flat[(v * 32 * d + y) * w + f * 16 * d + x]),
        ),
      );
  return frames;
}

async function render() {
  const out = path.join(OUT, 'render');
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  const ex = src('hd-bunny-sheet-example.png');
  // the bunny at every density, converted from the source on its own grid
  const sheets: Record<number, Rgba> = {};
  for (const d of [1, 2, 3, 4]) {
    const r = hdSheetFromBoxes(ex, { density: d, mirror: [false, false, true] });
    if ('error' in r) throw new Error(r.error);
    sheets[d] = { width: r.width, height: r.height, data: r.data };
  }
  // the chain from 64×128: its 32×64 and 16×32 copies
  const chain = { 4: sheets[4], 2: halve(sheets[4]), 1: halve(halve(sheets[4])) };
  const classic = read(path.join(root, 'webview-ui/public/assets/characters/char_0.png'));

  // 1. bytes: decoded RGBA and PNG per sheet
  const png = (img: Rgba) => {
    const p = new PNG({ width: img.width, height: img.height });
    p.data = Buffer.from(img.data);
    return PNG.sync.write(p).length;
  };
  const bytes = Object.fromEntries(
    [1, 2, 3, 4].map((d) => [
      SPEC_NAME[d] ?? '16x32',
      { rgba: sheets[d].data.length, png: png(sheets[d]) },
    ]),
  );

  // 2. SpriteData heap per character (string[][] frames, shared colour strings)
  const gc = (globalThis as { gc?: () => void }).gc;
  const heap: Record<string, number> = {};
  const compose: Record<string, number> = {};
  for (const d of [1, 2, 3, 4]) {
    const palette = Array.from(
      { length: 40 },
      (_, i) => `#${(i * 404040).toString(16).padStart(6, '0').slice(0, 6)}`,
    );
    const size = 112 * d * 96 * d;
    const layers = Array.from({ length: COMPOSE_LAYERS }, (_, l) =>
      Array.from({ length: size }, (_, i) =>
        ((i * 2654435761 + l * 97) % 1000) / 1000 < LAYER_FILL
          ? String.fromCharCode(48 + (i % 40))
          : '.',
      ),
    );
    gc?.();
    const before = process.memoryUsage().heapUsed;
    const t0 = performance.now();
    const kept: string[][][][] = [];
    for (let c = 0; c < BENCH_CHARACTERS; c++) kept.push(composeLoop(d, layers, palette));
    compose[SPEC_NAME[d] ?? '16x32'] = round((performance.now() - t0) / BENCH_CHARACTERS, 1);
    gc?.();
    heap[SPEC_NAME[d] ?? '16x32'] = Math.round(
      (process.memoryUsage().heapUsed - before) / BENCH_CHARACTERS,
    );
    void kept.length;
  }

  // 3. in Chromium: building the sprite cache (today: one fillRect per pixel at zoom/density; or
  // the sheet's own pixels once, then one scaled draw) and the frame time of 20 characters
  const browser = await launchBrowser({ headless: true });
  const page = await browser.newPage({
    viewport: { width: BENCH_CANVAS.w, height: BENCH_CANVAS.h },
  });
  await page.setContent('<html><body style="margin:0"></body></html>');
  // tsx keeps function names with a helper the page does not have
  await page.evaluate('window.__name = (f) => f');
  const toPlain = (img: Rgba) => ({ w: img.width, h: img.height, data: Array.from(img.data) });
  const bench = await page.evaluate(
    async ({ sheets, zoom, chars, frames, canvas, bg }) => {
      const hex = (c: number[]) => `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
      const res: Record<string, unknown> = {};
      for (const [d, s] of Object.entries(sheets) as [
        string,
        { w: number; h: number; data: number[] },
      ][]) {
        const dd = Number(d);
        const fw = 16 * dd;
        const fh = 32 * dd;
        const sprite = (r: number, f: number) =>
          Array.from({ length: fh }, (_, y) =>
            Array.from({ length: fw }, (_, x) => {
              const o = ((r * fh + y) * s.w + f * fw + x) * 4;
              return s.data[o + 3]
                ? `#${[0, 1, 2].map((k) => s.data[o + k].toString(16).padStart(2, '0')).join('')}`
                : '';
            }),
          );
        const spr: string[][][] = [];
        for (let r = 0; r < 3; r++) for (let f = 0; f < 7; f++) spr.push(sprite(r, f));
        const scale = zoom / dd;
        const fill = (sd: string[][]) => {
          const c = document.createElement('canvas');
          c.width = Math.round(fw * scale);
          c.height = Math.round(fh * scale);
          const x = c.getContext('2d')!;
          x.imageSmoothingEnabled = false;
          for (let yy = 0; yy < fh; yy++)
            for (let xx = 0; xx < fw; xx++) {
              const col = sd[yy][xx];
              if (!col) continue;
              x.fillStyle = col;
              x.fillRect(xx * scale, yy * scale, scale, scale);
            }
          return c;
        };
        const native = (r: number, f: number) => {
          const src = document.createElement('canvas');
          src.width = fw;
          src.height = fh;
          const id = new ImageData(fw, fh);
          for (let yy = 0; yy < fh; yy++)
            for (let xx = 0; xx < fw; xx++) {
              const o = ((r * fh + yy) * s.w + f * fw + xx) * 4;
              id.data.set(s.data.slice(o, o + 4), (yy * fw + xx) * 4);
            }
          src.getContext('2d')!.putImageData(id, 0, 0);
          const c = document.createElement('canvas');
          c.width = Math.round(fw * scale);
          c.height = Math.round(fh * scale);
          const x = c.getContext('2d')!;
          x.imageSmoothingEnabled = false;
          x.drawImage(src, 0, 0, c.width, c.height);
          return c;
        };
        let t0 = performance.now();
        const caches: HTMLCanvasElement[][] = [];
        for (let c = 0; c < chars; c++) {
          caches.push(spr.map(fill));
          caches[c][0].getContext('2d')!.getImageData(0, 0, 1, 1);
        }
        const fillMs = (performance.now() - t0) / chars;
        t0 = performance.now();
        const natives: HTMLCanvasElement[][] = [];
        for (let c = 0; c < chars; c++) {
          const n: HTMLCanvasElement[] = [];
          for (let r = 0; r < 3; r++) for (let f = 0; f < 7; f++) n.push(native(r, f));
          n[0].getContext('2d')!.getImageData(0, 0, 1, 1);
          natives.push(n);
        }
        const nativeMs = (performance.now() - t0) / chars;
        const main = document.createElement('canvas');
        main.width = canvas.w;
        main.height = canvas.h;
        const ctx = main.getContext('2d')!;
        ctx.imageSmoothingEnabled = false;
        const run = (set: HTMLCanvasElement[][]) => {
          const t = performance.now();
          for (let k = 0; k < frames; k++) {
            ctx.fillStyle = hex(bg);
            ctx.fillRect(0, 0, canvas.w, canvas.h);
            for (let c = 0; c < chars; c++)
              ctx.drawImage(
                set[c][(k + c) % 21],
                40 + (c % 10) * 120,
                100 + Math.floor(c / 10) * 300,
              );
            ctx.getImageData(0, 0, 1, 1);
          }
          return (performance.now() - t) / frames;
        };
        // the first pass rasterises what a canvas kept as drawing commands; the second is steady
        run(caches);
        const frameMs = run(caches);
        run(natives);
        const frameNativeMs = run(natives);
        const cacheBytes = caches[0].reduce((t, c) => t + c.width * c.height * 4, 0);
        res[d] = { fillMs, nativeMs, frameMs, frameNativeMs, cacheBytesPerCharacter: cacheBytes };
      }
      return res;
    },
    {
      sheets: Object.fromEntries([1, 2, 3, 4].map((d) => [d, toPlain(sheets[d])])),
      zoom: BENCH_ZOOM,
      chars: BENCH_CHARACTERS,
      frames: BENCH_FRAMES,
      canvas: BENCH_CANVAS,
      bg: FLOOR_RGB,
    },
  );

  // 4. what each zoom shows: today's draw (fillRect at zoom/density) of the standing front frame,
  // and the chain's best crisp copy (the largest density that divides the zoom)
  const shots = await page.evaluate(
    async ({ sheets, chain, classic, zooms, bg }) => {
      const hex = (c: number[]) => `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
      const draw = (
        s: { w: number; h: number; data: number[] },
        d: number,
        zoom: number,
        ctx: CanvasRenderingContext2D,
        ox: number,
        oy: number,
      ) => {
        const fw = 16 * d;
        const fh = 32 * d;
        const scale = zoom / d;
        for (let y = 0; y < fh; y++)
          for (let x = 0; x < fw; x++) {
            const o = (y * s.w + x) * 4;
            if (!s.data[o + 3]) continue;
            ctx.fillStyle = hex([s.data[o], s.data[o + 1], s.data[o + 2]]);
            ctx.fillRect(ox + x * scale, oy + y * scale, scale, scale);
          }
      };
      const out: Record<string, string> = {};
      for (const zoom of zooms) {
        // classic | 32×64 | 48×96 | 64×128 drawn today | chain copy, feet on one floor line
        const cw = 16 * zoom;
        const ch = 32 * zoom;
        const gap = 8;
        const c = document.createElement('canvas');
        c.width = (cw + gap) * 5 + gap;
        c.height = ch + gap * 2;
        const ctx = c.getContext('2d')!;
        ctx.imageSmoothingEnabled = false;
        ctx.fillStyle = hex(bg);
        ctx.fillRect(0, 0, c.width, c.height);
        draw(classic, 1, zoom, ctx, gap, gap);
        [2, 3, 4].forEach((d, i) => draw(sheets[d], d, zoom, ctx, gap + (cw + gap) * (i + 1), gap));
        const best = [4, 2, 1].find((d) => zoom % d === 0)!;
        draw(chain[best], best, zoom, ctx, gap + (cw + gap) * 4, gap);
        out[zoom] = c.toDataURL('image/png');
      }
      return out;
    },
    {
      sheets: Object.fromEntries([2, 3, 4].map((d) => [d, toPlain(sheets[d])])),
      chain: Object.fromEntries(Object.entries(chain).map(([d, im]) => [d, toPlain(im)])),
      classic: toPlain(classic),
      zooms: ZOOMS,
      bg: FLOOR_RGB,
    },
  );
  await browser.close();
  for (const [zoom, url] of Object.entries(shots))
    fs.writeFileSync(path.join(out, `zoom-${zoom}.png`), Buffer.from(url.split(',')[1], 'base64'));
  // the chain against the native conversions at the same size: 32×64 and 16×32
  const pair = (a: Rgba, b: Rgba, z: number) =>
    row([
      onDark(crop(a, [0, 0, a.width / 7, a.height / 3], z)),
      onDark(crop(b, [0, 0, b.width / 7, b.height / 3], z)),
    ]);
  write(path.join(out, 'chain-32x64-native-vs-from-64x128.png'), pair(sheets[2], chain[2], 6));
  write(path.join(out, 'chain-16x32-native-vs-from-64x128.png'), pair(sheets[1], chain[1], 12));
  const crisp = Object.fromEntries(
    ZOOMS.map((z) => [
      z,
      Object.fromEntries([1, 2, 3, 4].map((d) => [SPEC_NAME[d] ?? '16x32', z % d === 0])),
    ]),
  );
  const result = {
    bytes,
    heapPerCharacter: heap,
    composeMsPerCharacter: compose,
    chromium: bench,
    crispAtZoom: crisp,
  };
  fs.writeFileSync(path.join(OUT, 'render-metrics.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 1));
}

const step = process.argv[2];
if (step === 'source') source();
else if (step === 'specs') specs();
else if (step === 'render') void render();
else console.log('usage: res-study.ts source|specs|render');
