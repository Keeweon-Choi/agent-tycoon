/**
 * CHAR-HUMAN: the owner's drawing (cld/docs/design/char-parts.md §5) -> a part. Pure over decoded
 * RGBA; the routes and the CLI do the I/O. Steps:
 *   1. big blocks -> true pixels (assetSnap: grid fit, dominant colour per block, palette merge),
 *      skipped when the image already has a 1:1 template's size
 *   2. the layout: which template it was drawn on (a ×20 row or head sheet, or a 1:1 one), by size
 *   3. magenta background and the green mannequin go by colour distance; the mannequin aligns the
 *      drawing to the template (one shift for the image, then a small one per frame)
 *   4. what is left in each frame is the part, minus the white paper's known pixels; its colours
 *      merge, and the main colour's ramp (same hue, lighter and darker) is what recolours
 */
import { chroma, hue, parseHex, rgbToLab } from '../../../core/src/cld/color.js';
import type { PartSlot } from '../../../core/src/cld/looks.js';
import {
  encodePixels,
  HEAD_H,
  HEAD_W,
  parsePartFileName,
  PART_ALPHABET,
  PART_FRAME_H,
  PART_FRAME_W,
  PART_FRAMES,
  PART_VIEWS,
  PARTS_META,
  SHEET_H,
  SHEET_W,
} from '../../../core/src/cld/partData.js';
import { SLOT_REGISTRY } from '../../../core/src/cld/partRegistry.js';
import {
  type Cells,
  findGrid,
  MERGE_DISTANCE,
  mergePalette,
  type Rgba,
  snapWithGrid,
} from './assetSnap.js';
import { cleanup, MIN_COVER, sampleBlock } from './pixelResample.js';

export type PartView = (typeof PART_VIEWS)[number];
export const partKind = (slot: PartSlot) => SLOT_REGISTRY[slot].kind;

/** The standing frame: the head canvas is cut from it on the templates. */
const STANDING = 1;
const READ_FRAMES = [5, 6];
/** A drawing may be this many true pixels larger or smaller than its template. */
const SIZE_SLACK = 8;
/** The image and each frame are searched this far for the mannequin's best fit. */
const SHIFT = 6;
const FRAME_SHIFT = 2;
/** Fewer green pixels than this: no mannequin to align with (a 1:1 drawing exported without it). */
const MIN_GREEN = 30;
/** The mannequin must match the template at least this well (else: another template). */
const MIN_FIT = 0.9;
/** The template's grey frame lines: this far from magenta (a resize blends them with it), magenta
 *  this many pixels to each side (the line is thin), across this share of the image. */
const LINE_FROM_MAGENTA = 50;
const LINE_SIDE = 4;
const LINE_SHARE = 0.4;
/** Telling a row's frames apart: the chest band (rows and columns in the standing frame). */
const BAND_ROWS = [17, 24];
const BAND_COLS = [2, 13];
/** Pose twins whose chest histograms are closer than this share a flag. */
const TWIN_NEAR = 0.12;
const POSE_TWINS = [
  [0, 2],
  [3, 4],
];
/** The share of a block's sides left out when its dominant colour is taken. */
const DOMINANT_MARGIN = 0.25;
/** Colour distances (RGB) to the template's magenta and greens that count as them. */
const BG_DISTANCE = 100;
const GREEN_DISTANCE = 90;
/** A colour whose green leads red and blue by this much is the mannequin's. */
const GREEN_LEAD = 40;
const MAGENTA = [255, 0, 255];
const GREENS = [
  [0, 255, 0],
  [0, 160, 0],
];
/** Outline colours (darker than this OKLab L) never recolour; greys below GREY_CHROMA are a grey ramp. */
const OUTLINE_L = 0.25;
const GREY_CHROMA = 0.04;
const RAMP_HUE_DEG = 30;
/** Merges widen by this step until the part fits the 62-colour pixel alphabet. */
const MAX_COLOURS = 62;
const MERGE_STEP = 8;

interface Layout {
  name: string;
  w: number;
  h: number;
  cw: number;
  ch: number;
  /** Per cell: its top-left in the layout and the frame (view row, frame) or head view it holds. */
  cells: { x: number; y: number; view: number; frame: number }[];
}

/** The ×20 templates (cld/scripts/gen-char-templates.ts): cells one block apart, a 2-block margin. */
const MARGIN = 2;
function spaced(
  name: string,
  n: number,
  cw: number,
  ch: number,
  cell: (c: number) => { view: number; frame: number },
): Layout {
  return {
    name,
    w: MARGIN * 2 + n * (cw + 1) - 1,
    h: MARGIN * 2 + ch,
    cw,
    ch,
    cells: Array.from({ length: n }, (_, c) => ({
      x: MARGIN + c * (cw + 1),
      y: MARGIN,
      ...cell(c),
    })),
  };
}
function packed(
  name: string,
  cols: number,
  rows: number,
  cw: number,
  ch: number,
  cell: (c: number, r: number) => { view: number; frame: number },
): Layout {
  return {
    name,
    w: cols * cw,
    h: rows * ch,
    cw,
    ch,
    cells: Array.from({ length: cols * rows }, (_, i) => ({
      x: (i % cols) * cw,
      y: Math.floor(i / cols) * ch,
      ...cell(i % cols, Math.floor(i / cols)),
    })),
  };
}
const { headBox } = PARTS_META;
function layoutsFor(kind: 'sheet' | 'head', view: number | null): Layout[] {
  if (kind === 'head')
    return [
      spaced('head-x20', PART_VIEWS.length, headBox.w, headBox.h, (c) => ({
        view: c,
        frame: STANDING,
      })),
      packed('head-1x', PART_VIEWS.length, 1, headBox.w, headBox.h, (c) => ({
        view: c,
        frame: STANDING,
      })),
    ];
  if (view !== null)
    return [
      spaced('row-x20', PART_FRAMES, PART_FRAME_W, PART_FRAME_H, (c) => ({ view, frame: c })),
      packed('row-1x', PART_FRAMES, 1, PART_FRAME_W, PART_FRAME_H, (c) => ({ view, frame: c })),
    ];
  return [
    packed('sheet-1x', PART_FRAMES, PART_VIEWS.length, PART_FRAME_W, PART_FRAME_H, (c, r) => ({
      view: r,
      frame: c,
    })),
  ];
}

const ALPHABET_INDEX = (k: string) => PART_ALPHABET.indexOf(k);
const basic = PARTS_META.parts.find((p) => p.id === 'basic')!;
const sheetPx = (part: { palette: string[]; pixels: string }, x: number, y: number) => {
  const k = part.pixels[y * SHEET_W + x];
  return k === '.' ? '' : part.palette[ALPHABET_INDEX(k)];
};
/** Where a cell's mannequin and paper are, in the cell's own coordinates. */
function templateAt(kind: 'sheet' | 'head', view: number, frame: number, x: number, y: number) {
  const [fx, fy] = kind === 'head' ? [x + headBox.x, y + headBox.y] : [x, y];
  if (fx < 0 || fy < 0 || fx >= PART_FRAME_W || fy >= PART_FRAME_H)
    return { body: false, paper: false };
  const sx = frame * PART_FRAME_W + fx;
  const sy = view * PART_FRAME_H + fy;
  return {
    body: !!sheetPx(basic, sx, sy),
    paper: kind === 'sheet' && READ_FRAMES.includes(frame) && !!sheetPx(PARTS_META.paper, sx, sy),
  };
}

const dist = (a: ArrayLike<number>, b: readonly number[]) =>
  Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
type Px = 'bg' | 'green' | 'ink';

export type MismatchMode = 'borrow' | 'empty' | 'keep';
export type Facing = 'front' | 'back' | 'unknown';

export interface FrameReport {
  /** The frame's index in its row (0-6), or the head view (0-2). */
  frame: number;
  /** Which way the template wants it, and which way the drawing's mannequin faces (by its eye dots;
   *  'unknown' when they are drawn over or the view is the side). */
  want: Facing;
  seen: Facing;
  /** What the part holds there: the drawing, another frame of the row moved to this one, nothing. */
  fix: 'kept' | 'borrowed' | 'emptied';
  from?: number;
}

export interface ImportedPart {
  kind: 'sheet' | 'head';
  palette: string[];
  pixels: string;
  ramp: string[];
  /** The drawing at twice the detail (32×64 per frame), from the template's half blocks; null when
   *  the image has no finer detail than its blocks (a snapped or 1:1 drawing). */
  hd: { width: number; height: number; data: Uint8Array } | null;
  report: {
    layout: string;
    /** How the blocks were found: from the grey frame lines, or by snapping to a grid. */
    grid: 'lines' | 'snap' | '1x';
    /** The drawing's offset from the template (true pixels), and each frame's extra one. */
    shift: [number, number];
    frameShifts: [number, number][];
    /** 1 - (green off the template's mannequin + mannequin pixels gone) / mannequin pixels; null:
     *  no mannequin seen. */
    fit: number | null;
    colours: number;
    frames: FrameReport[];
  };
}

/** The colours a picked colour replaces: the most used non-outline colour and its same-hue steps. */
export function rampOf(counts: ReadonlyMap<string, number>): string[] {
  const lab = (c: string) => rgbToLab(parseHex(`#${c}`));
  const candidates = [...counts].filter(([c]) => lab(c).L >= OUTLINE_L).sort((a, b) => b[1] - a[1]);
  if (!candidates.length) return [];
  const m = lab(candidates[0][0]);
  return candidates
    .map(([c]) => c)
    .filter((c) => {
      const l = lab(c);
      if (chroma(m) < GREY_CHROMA) return chroma(l) < GREY_CHROMA * 1.5;
      if (chroma(l) < GREY_CHROMA / 2) return false;
      return Math.abs(((hue(l) - hue(m) + 540) % 360) - 180) <= RAMP_HUE_DEG;
    });
}

/** Per template cell, its blocks (and half blocks) sampled with a FRAME_SHIFT margin. */
interface CellSample {
  /** rgb per block, (cw + 2P) × (ch + 2P); cls and darkness per block. */
  rgb: Uint8Array;
  cls: Px[];
  dark: boolean[];
  hd: { rgb: Uint8Array; cls: Px[] } | null;
}
const P = FRAME_SHIFT;
/** The dominant colour of a box's centre (assetSnap's rule: the soft edges are left out). */
function dominant(img: Rgba, x0: number, y0: number, x1: number, y1: number): number[] | null {
  const mx = (x1 - x0) * DOMINANT_MARGIN;
  const my = (y1 - y0) * DOMINANT_MARGIN;
  const buckets = new Map<number, { n: number; r: number; g: number; b: number }>();
  let total = 0;
  let opaque = 0;
  for (let y = Math.ceil(y0 + my); y < Math.floor(y1 - my) || y === Math.ceil(y0 + my); y++)
    for (let x = Math.ceil(x0 + mx); x < Math.floor(x1 - mx) || x === Math.ceil(x0 + mx); x++) {
      if (x < 0 || y < 0 || x >= img.width || y >= img.height) continue;
      total++;
      const i = (y * img.width + x) * 4;
      if (img.data[i + 3] < 128) continue;
      opaque++;
      const key =
        ((img.data[i] >> 4) << 8) | ((img.data[i + 1] >> 4) << 4) | (img.data[i + 2] >> 4);
      const e = buckets.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
      e.n++;
      e.r += img.data[i];
      e.g += img.data[i + 1];
      e.b += img.data[i + 2];
      buckets.set(key, e);
    }
  let top = { n: 0, r: 0, g: 0, b: 0 };
  for (const e of buckets.values()) if (e.n > top.n) top = e;
  // the most common colour of the centre (a finer drawing mixes several in one block); mostly
  // transparent is background
  if (!top.n || opaque * 2 < total) return null;
  return [top.r / top.n, top.g / top.n, top.b / top.n].map(Math.round);
}
/** The mannequin: near its two greens, or any strongly green colour (its edge blended with a
 *  neighbour by the generator; parts never use green, the guide says). */
const greenish = (p: ArrayLike<number>) =>
  GREENS.some((g) => dist(p, g) < GREEN_DISTANCE) ||
  (p[1] > p[0] + GREEN_LEAD && p[1] > p[2] + GREEN_LEAD);
const classify = (p: ArrayLike<number> | null): Px =>
  !p || dist(p, MAGENTA) < BG_DISTANCE ? 'bg' : greenish(p) ? 'green' : 'ink';
/** Not the part: magenta, the mannequin's greens, transparent. */
const notPart = (r: number, g: number, b: number, a: number) =>
  a < 128 || classify([r, g, b]) !== 'ink';
const isDark = (p: ArrayLike<number> | null) => !!p && dist(p, GREENS[1]) < dist(p, GREENS[0]);

/** The grey frame lines' centres (thin grey runs across most of the image), or null. */
function frameLines(img: Rgba, vertical: boolean): number[] {
  const [n, m] = vertical ? [img.width, img.height] : [img.height, img.width];
  const px = (x: number, y: number) =>
    x < 0 || y < 0 || x >= img.width || y >= img.height
      ? null
      : img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 3);
  // the line's grey, blended with the magenta beside it by a resize: anything clearly not magenta
  // and not the mannequin's green
  const line = (x: number, y: number) => {
    const p = px(x, y);
    return (
      !!p &&
      dist(p, MAGENTA) > LINE_FROM_MAGENTA &&
      !GREENS.some((g) => dist(p, g) < GREEN_DISTANCE)
    );
  };
  const magenta = (x: number, y: number) => {
    const p = px(x, y);
    return !!p && dist(p, MAGENTA) < BG_DISTANCE;
  };
  const hit: number[] = [];
  for (let a = 0; a < n; a++) {
    let count = 0;
    for (let b = 0; b < m; b++) {
      const [x, y] = vertical ? [a, b] : [b, a];
      const [ox, oy] = vertical ? [LINE_SIDE, 0] : [0, LINE_SIDE];
      // a thin line: not magenta here, magenta a few pixels to each side (hair and clothes are wide)
      if (line(x, y) && magenta(x - ox, y - oy) && magenta(x + ox, y + oy)) count++;
    }
    if (count >= m * LINE_SHARE) hit.push(a);
  }
  const centres: number[] = [];
  for (let i = 0; i < hit.length;) {
    let j = i;
    while (j + 1 < hit.length && hit[j + 1] - hit[j] <= 2) j++;
    centres.push((hit[i] + hit[j]) / 2);
    i = j + 1;
  }
  return centres;
}

/** Path A: the image's frame lines give each cell its own block size, so a drawing resized or drawn
 *  finer than the template still maps onto the template's blocks. */
function sampleByLines(img: Rgba, layout: Layout): CellSample[] | null {
  if (!layout.name.endsWith('-x20')) return null;
  const v = frameLines(img, true);
  const h = frameLines(img, false);
  if (v.length !== layout.cells.length + 1 || h.length !== 2) return null;
  const by = (h[1] - h[0]) / (layout.ch + 1);
  return layout.cells.map((_, c) => {
    const bx = (v[c + 1] - v[c]) / (layout.cw + 1);
    const ox = v[c] + bx / 2;
    const oy = h[0] + by / 2;
    const w = layout.cw + 2 * P;
    const hh = layout.ch + 2 * P;
    const rgb = new Uint8Array(w * hh * 3);
    const cls: Px[] = [];
    const dark: boolean[] = [];
    for (let y = 0; y < hh; y++)
      for (let x = 0; x < w; x++) {
        const X = ox + (x - P) * bx;
        const Y = oy + (y - P) * by;
        const p = dominant(img, X, Y, X + bx, Y + by);
        if (p) rgb.set(p, (y * w + x) * 3);
        cls.push(classify(p));
        dark.push(isDark(p));
      }
    const hdRgb = new Uint8Array(w * 2 * hh * 2 * 3);
    const hdCls: Px[] = [];
    for (let y = 0; y < hh * 2; y++)
      for (let x = 0; x < w * 2; x++) {
        const X = ox + (x / 2 - P) * bx;
        const Y = oy + (y / 2 - P) * by;
        // the drawing's own detail: drawn where it covers a fair share of the half block, in its
        // outline colour on a dark edge (pixelResample.ts, shared with the HD sheet converter)
        const s = sampleBlock(img, X, Y, X + bx / 2, Y + by / 2, notPart);
        const drawn = s.cover >= MIN_COVER && s.colour;
        if (drawn) hdRgb.set(s.colour!, (y * w * 2 + x) * 3);
        hdCls.push(drawn ? 'ink' : 'bg');
      }
    return { rgb, cls, dark, hd: { rgb: hdRgb, cls: hdCls } };
  });
}

/** The drawing as a part, or why not. `view`: the one body row a `-down|-up|-right` file holds;
 *  `mismatch`: what a frame drawn facing the wrong way becomes (another frame of the row moved to it,
 *  nothing, or the drawing as it is). */
export function importPart(
  img: Rgba,
  slot: PartSlot,
  view: PartView | null = null,
  opts: {
    mismatch?: MismatchMode;
    /** The owner's own call per frame (index in the row, or head view), over the automatic one. */
    frames?: Partial<Record<number, MismatchMode>>;
  } = {},
): ImportedPart | { error: string } {
  const kind = partKind(slot);
  const mismatch = opts.mismatch ?? 'borrow';
  if (kind === 'head' && view !== null)
    return { error: 'a head part has no row (-down, -up, -right)' };
  const layouts = layoutsFor(kind, view === null ? null : PART_VIEWS.indexOf(view));
  // 1. the template's blocks: from the frame lines, else by snapping to the image's own grid
  let layout = layouts[0];
  let samples: CellSample[] | null = null;
  let grid: ImportedPart['report']['grid'] = 'lines';
  let shift: [number, number] = [0, 0];
  for (const l of layouts) {
    samples = sampleByLines(img, l);
    if (samples) {
      layout = l;
      break;
    }
  }
  if (!samples) {
    let cells: Cells;
    grid = layouts.some((l) => l.w === img.width && l.h === img.height) ? '1x' : 'snap';
    if (grid === '1x')
      cells = { cols: img.width, rows: img.height, data: new Uint8Array(img.data) };
    else {
      try {
        cells = snapWithGrid(img, findGrid(img));
      } catch (err) {
        return {
          error: `no block grid found (${err instanceof Error ? err.message : String(err)})`,
        };
      }
    }
    const off = (l: Layout) => Math.abs(cells.cols - l.w) + Math.abs(cells.rows - l.h);
    layout = [...layouts].sort((a, b) => off(a) - off(b))[0];
    if (off(layout) > SIZE_SLACK)
      return {
        error: `${cells.cols}×${cells.rows} pixels after snapping, not the ${kind === 'head' ? 'head' : view ? 'row' : 'sheet'} template's ${layout.w}×${layout.h}`,
      };
    const px = (x: number, y: number) =>
      x < 0 ||
      y < 0 ||
      x >= cells.cols ||
      y >= cells.rows ||
      cells.data[(y * cells.cols + x) * 4 + 3] < 128
        ? null
        : cells.data.subarray((y * cells.cols + x) * 4, (y * cells.cols + x) * 4 + 3);
    // one shift for the whole image, by the mannequin
    const at = (x: number, y: number) => classify(px(x, y));
    if (cells.data.length && countGreen(cells) >= MIN_GREEN) {
      let best = -Infinity;
      for (let dy = -SHIFT; dy <= SHIFT; dy++)
        for (let dx = -SHIFT; dx <= SHIFT; dx++) {
          let score = 0;
          layout.cells.forEach((cell, c) => {
            score -= badOf(kind, layout, c, (x, y) => at(cell.x + x + dx, cell.y + y + dy)).bad;
          });
          if (score > best) [best, shift] = [score, [dx, dy]];
        }
    }
    samples = layout.cells.map((cell) => {
      const w = layout.cw + 2 * P;
      const hh = layout.ch + 2 * P;
      const rgb = new Uint8Array(w * hh * 3);
      const cls: Px[] = [];
      const dark: boolean[] = [];
      for (let y = 0; y < hh; y++)
        for (let x = 0; x < w; x++) {
          const p = px(cell.x + x - P + shift[0], cell.y + y - P + shift[1]);
          if (p) rgb.set(p, (y * w + x) * 3);
          cls.push(classify(p));
          dark.push(isDark(p));
        }
      return { rgb, cls, dark, hd: null };
    });
  }
  const w = layout.cw + 2 * P;
  const sat = (s: CellSample, x: number, y: number): Px =>
    x < -P || y < -P || x >= layout.cw + P || y >= layout.ch + P
      ? 'bg'
      : s.cls[(y + P) * w + x + P];
  // 2. each frame's own small move, the fit, and which way it faces
  const green = samples.reduce((n, s) => n + s.cls.filter((c) => c === 'green').length, 0);
  const frameShifts: [number, number][] = samples.map((s, c) => {
    if (green < MIN_GREEN) return [0, 0];
    let best = -Infinity;
    let m: [number, number] = [0, 0];
    for (let dy = -FRAME_SHIFT; dy <= FRAME_SHIFT; dy++)
      for (let dx = -FRAME_SHIFT; dx <= FRAME_SHIFT; dx++) {
        // ties keep the smaller move
        const score =
          -badOf(kind, layout, c, (x, y) => sat(s, x + dx, y + dy)).bad -
          (Math.abs(dx) + Math.abs(dy)) * 1e-3;
        if (score > best) [best, m] = [score, [dx, dy]];
      }
    return m;
  });
  let fit: number | null = null;
  if (green >= MIN_GREEN) {
    let bad = 0;
    let all = 0;
    samples.forEach((s, c) => {
      const [dx, dy] = frameShifts[c];
      const f = badOf(kind, layout, c, (x, y) => sat(s, x + dx, y + dy));
      bad += f.bad;
      all += f.body;
    });
    fit = all ? Math.max(0, 1 - bad / all) : 0;
    if (fit < MIN_FIT)
      return {
        error: `the green mannequin does not match the ${layout.name} template (${Math.round(fit * 100)}% on it)`,
      };
  }
  const eyes = layout.cells.map((cell, c) =>
    wantedFacing(cell) === 'unknown'
      ? 'unknown'
      : facingOf(kind, cell, samples![c], frameShifts[c], layout),
  );
  const seenAs =
    kind === 'sheet'
      ? rowFacing(layout, samples, frameShifts, eyes)
      : // a head view: only dark eye dots on the back view tell (a generator often drops them)
        layout.cells.map((cell, c) =>
          wantedFacing(cell) === 'back' && eyes[c] === 'front' ? 'front' : wantedFacing(cell),
        );
  const frames: FrameReport[] = layout.cells.map((cell, c) => ({
    frame: kind === 'head' ? cell.view : cell.frame,
    want: wantedFacing(cell),
    seen: seenAs[c],
    fix: 'kept',
  }));
  const wrong = (c: number) =>
    frames[c].want !== 'unknown' &&
    frames[c].seen !== 'unknown' &&
    frames[c].seen !== frames[c].want;
  // 3. the part (and its HD source)
  const outW = kind === 'head' ? HEAD_W : SHEET_W;
  const outH = kind === 'head' ? HEAD_H : SHEET_H;
  const out: Cells = { cols: outW, rows: outH, data: new Uint8Array(outW * outH * 4) };
  const hd = samples.every((s) => s.hd) ? new Uint8Array(outW * 2 * outH * 2 * 4) : null;
  const anchorDy = (cell: Layout['cells'][number]) =>
    kind === 'head' ? 0 : PARTS_META.headAnchors[cell.view * PART_FRAMES + cell.frame][1];
  const paint = (c: number, from: number) => {
    const cell = layout.cells[c];
    const src = layout.cells[from];
    const s = samples![from];
    const [dx, dy] = frameShifts[from];
    const moveY = anchorDy(cell) - anchorDy(src); // a borrowed frame follows this frame's head
    const [ox, oy] =
      kind === 'head'
        ? [cell.view * headBox.w, 0]
        : [cell.frame * PART_FRAME_W, cell.view * PART_FRAME_H];
    for (let y = 0; y < layout.ch; y++)
      for (let x = 0; x < layout.cw; x++) {
        const sy = y - moveY;
        // neither this frame's paper nor the paper drawn in the frame it is taken from
        if (
          sat(s, x + dx, sy + dy) !== 'ink' ||
          templateAt(kind, cell.view, cell.frame, x, y).paper ||
          templateAt(kind, src.view, src.frame, x, sy).paper
        )
          continue;
        const i = (sy + dy + P) * w + x + dx + P;
        out.data.set([...s.rgb.subarray(i * 3, i * 3 + 3), 255], ((oy + y) * outW + ox + x) * 4);
      }
    if (!hd || !s.hd) return;
    for (let y = 0; y < layout.ch * 2; y++)
      for (let x = 0; x < layout.cw * 2; x++) {
        if (
          templateAt(kind, cell.view, cell.frame, x >> 1, y >> 1).paper ||
          templateAt(kind, src.view, src.frame, x >> 1, (y >> 1) - moveY).paper
        )
          continue;
        const sx = x + 2 * (dx + P);
        const sy = y - 2 * moveY + 2 * (dy + P);
        if (sx < 0 || sy < 0 || sx >= w * 2 || sy >= (layout.ch + 2 * P) * 2) continue;
        const i = sy * w * 2 + sx;
        if (s.hd.cls[i] !== 'ink') continue;
        hd.set(
          [...s.hd.rgb.subarray(i * 3, i * 3 + 3), 255],
          ((2 * oy + y) * outW * 2 + 2 * ox + x) * 4,
        );
      }
  };
  const action = (c: number): MismatchMode => opts.frames?.[c] ?? (wrong(c) ? mismatch : 'keep');
  layout.cells.forEach((cell, c) => {
    if (action(c) === 'keep') return paint(c, c);
    if (action(c) === 'borrow' && kind === 'sheet') {
      // the same pose first (walking 0-2, typing 3-4, reading 5-6), then a frame without the paper
      // (its body under the paper was never drawn), then the nearest
      const group = (f: number) => (f < 3 ? 0 : f < 5 ? 1 : 2);
      const rank = (d: number) =>
        (group(layout.cells[d].frame) === group(cell.frame) ? 0 : 2) +
        (READ_FRAMES.includes(layout.cells[d].frame) && !READ_FRAMES.includes(cell.frame) ? 1 : 0);
      const donor = layout.cells
        .map((_, d) => d)
        .filter((d) => d !== c && action(d) === 'keep')
        .sort((a, b) => rank(a) - rank(b) || Math.abs(a - c) - Math.abs(b - c))[0];
      if (donor !== undefined) {
        frames[c].fix = 'borrowed';
        frames[c].from = layout.cells[donor].frame;
        return paint(c, donor);
      }
    }
    frames[c].fix = 'emptied';
  });
  // the HD art's one-pixel holes and stray specks go (as in the HD sheet converter)
  if (hd)
    cleanup({
      cols: outW * 2,
      rows: outH * 2,
      data: hd,
      cover: new Float32Array(outW * outH * 4),
      dark: new Array(outW * outH * 4).fill(null),
    });
  let colours = mergePalette(out);
  for (let d = MERGE_DISTANCE + MERGE_STEP; colours > MAX_COLOURS; d += MERGE_STEP)
    colours = mergePalette(out, d);
  const hexAt = (x: number, y: number) => {
    const o = (y * outW + x) * 4;
    return out.data[o + 3]
      ? [0, 1, 2].map((k) => out.data[o + k].toString(16).padStart(2, '0')).join('')
      : '';
  };
  const enc = encodePixels(outW, outH, hexAt)!;
  if (!enc.pixels.replace(/\./g, '').length)
    return { error: 'nothing drawn: only background and mannequin' };
  const counts = new Map<string, number>();
  for (const k of enc.pixels)
    if (k !== '.')
      counts.set(
        enc.palette[ALPHABET_INDEX(k)],
        (counts.get(enc.palette[ALPHABET_INDEX(k)]) ?? 0) + 1,
      );
  return {
    kind,
    ...enc,
    ramp: rampOf(counts),
    hd: hd ? { width: outW * 2, height: outH * 2, data: hd } : null,
    report: {
      layout: layout.name,
      grid,
      shift,
      frameShifts,
      fit,
      colours: enc.palette.length,
      frames,
    },
  };
}

function countGreen(cells: Cells): number {
  let n = 0;
  for (let i = 0; i < cells.data.length; i += 4)
    if (
      cells.data[i + 3] >= 128 &&
      GREENS.some((g) => dist(cells.data.subarray(i, i + 3), g) < GREEN_DISTANCE)
    )
      n++;
  return n;
}

const maskCache = new Map<string, Uint8Array>();
/** Green off the template's mannequin and background where the mannequin should be (it is either
 *  seen or drawn over, never gone), for cell `c` read through `at` (cell coordinates). */
function badOf(
  kind: 'sheet' | 'head',
  layout: Layout,
  c: number,
  at: (x: number, y: number) => Px,
) {
  const cell = layout.cells[c];
  const key = `${layout.name}:${kind}:${cell.view}:${cell.frame}`;
  let mask = maskCache.get(key);
  if (!mask) {
    const on = (x: number, y: number) =>
      x >= 0 &&
      y >= 0 &&
      x < layout.cw &&
      y < layout.ch &&
      templateAt(kind, cell.view, cell.frame, x, y).body;
    // 2 inside the mannequin, 1 on its outline ring (a generator often redraws that a pixel off)
    mask = Uint8Array.from({ length: layout.cw * layout.ch }, (_, i) => {
      const x = i % layout.cw;
      const y = Math.floor(i / layout.cw);
      if (!on(x, y)) return 0;
      return on(x - 1, y) && on(x + 1, y) && on(x, y - 1) && on(x, y + 1) ? 2 : 1;
    });
    maskCache.set(key, mask);
  }
  let body = 0;
  let bad = 0;
  for (let y = -FRAME_SHIFT; y < layout.ch + FRAME_SHIFT; y++)
    for (let x = -FRAME_SHIFT; x < layout.cw + FRAME_SHIFT; x++) {
      const seen = at(x, y);
      const m = x >= 0 && y >= 0 && x < layout.cw && y < layout.ch ? mask[y * layout.cw + x] : 0;
      if (m === 2) {
        body++;
        if (seen === 'bg') bad++;
      } else if (m === 0 && seen === 'green') bad++;
    }
  return { body, bad };
}

/** A position-free colour histogram of a frame's chest band (aligned by the head anchor, the
 *  paper's pixels left out): what the frame shows there, whatever the pose. */
function bandHistogram(
  frame: number,
  view: number,
  colourAt: (x: number, y: number) => ArrayLike<number> | null,
): Map<number, number> {
  const dy = PARTS_META.headAnchors[view * PART_FRAMES + frame][1] - headBox.y;
  const h = new Map<number, number>();
  let n = 0;
  for (let y = BAND_ROWS[0] + dy; y <= BAND_ROWS[1] + dy; y++)
    for (let x = BAND_COLS[0]; x <= BAND_COLS[1]; x++) {
      if (templateAt('sheet', view, frame, x, y).paper) continue;
      const p = colourAt(x, y);
      if (!p) continue;
      const k = (p[0] >> 6) * 16 + (p[1] >> 6) * 4 + (p[2] >> 6);
      h.set(k, (h.get(k) ?? 0) + 1);
      n++;
    }
  for (const [k, v] of h) h.set(k, v / Math.max(1, n));
  return h;
}
const histApart = (a: Map<number, number>, b: Map<number, number>) => {
  if (!a.size || !b.size) return 1;
  let d = 0;
  for (const k of new Set([...a.keys(), ...b.keys()]))
    d += Math.abs((a.get(k) ?? 0) - (b.get(k) ?? 0));
  return d / 2;
};

/** Which way each frame of a front or back row faces (the side row is not told):
 *  - eye dots: the front row's frames show them, the back row's do not (the reading frames are left
 *    out: generators drop the dots under the reading glasses);
 *  - a frame flagged pulls in its pose twin (walk 1/3, type 1/2) when their chests look alike.
 *  ponytail: a back-row frame drawn from the front on a mannequin without eye dots is not seen (one
 *  image has no cue for it); the owner marks it in the preview (`frames`). */
function rowFacing(
  layout: Layout,
  samples: CellSample[],
  shifts: [number, number][],
  eyes: Facing[],
): Facing[] {
  const want = wantedFacing(layout.cells[0]);
  if (want === 'unknown') return layout.cells.map(() => 'unknown');
  const against: Facing = want === 'front' ? 'back' : 'front';
  const w = layout.cw + 2 * P;
  const view = layout.cells[0].view;
  const hists = layout.cells.map((cell, c) =>
    bandHistogram(cell.frame, view, (x, y) => {
      const i = (y + shifts[c][1] + P) * w + x + shifts[c][0] + P;
      return samples[c].cls[i] === 'ink' ? samples[c].rgb.subarray(i * 3, i * 3 + 3) : null;
    }),
  );
  const flagged = layout.cells.map(
    (cell, c) => !READ_FRAMES.includes(cell.frame) && eyes[c] === against,
  );
  for (const [a, b] of POSE_TWINS)
    if ((flagged[a] || flagged[b]) && histApart(hists[a], hists[b]) < TWIN_NEAR)
      flagged[a] = flagged[b] = true;
  return flagged.map((f) => (f ? against : want));
}

/** The front row and the head's front view face the viewer; the back ones away; the side is not told. */
function wantedFacing(cell: Layout['cells'][number]): Facing {
  return cell.view === 0 ? 'front' : cell.view === 1 ? 'back' : 'unknown';
}

/** Which way the drawing's mannequin faces: dark eye dots where the template has them (front), plain
 *  green there (back), else unknown (drawn over). */
function facingOf(
  kind: 'sheet' | 'head',
  cell: Layout['cells'][number],
  s: CellSample,
  [dx, dy]: [number, number],
  layout: Layout,
): Facing {
  const { eyeHints } = PARTS_META;
  const [, ay] =
    PARTS_META.headAnchors[cell.view * PART_FRAMES + (kind === 'head' ? STANDING : cell.frame)];
  const w = layout.cw + 2 * P;
  let dark = 0;
  let plain = 0;
  let n = 0;
  for (const ex of eyeHints.front)
    for (const ey of eyeHints.rows) {
      // the eye in cell coordinates: its frame position, on the head canvas for a head cell
      const x = ex + dx;
      const y = (kind === 'head' ? ey - headBox.y : ey + ay - headBox.y) + dy;
      n++;
      if (x < -P || y < -P || x >= layout.cw + P || y >= layout.ch + P) continue;
      const i = (y + P) * w + x + P;
      if (s.cls[i] !== 'green') continue;
      if (s.dark[i]) dark++;
      else plain++;
    }
  if (dark * 2 >= n) return 'front';
  if (plain * 2 >= n) return 'back';
  return 'unknown';
}

export { parsePartFileName };
