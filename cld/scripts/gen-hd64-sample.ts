/**
 * HD64-SAMPLE: the 64×128 master of the silver-haired bunny girl (owner 10-25 22:28), built from the
 * owner's HD example: its real walking poses per view (converted at density 4), the seated typing
 * and reading frames re-posed from her own cut-out limbs, three expressions, then split into parts
 * (cld/packs/hd-bunny/) with a hand-tuned 16×32 copy of each. Writes the pack and the comparison
 * pictures under cld/artifacts/hd64/.
 *
 *   npx tsx cld/scripts/gen-hd64-sample.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { PNG } from 'pngjs';

import { PARTS_META } from '../../core/src/cld/partData.js';
import type { Rgba } from '../../server/src/cld/assetSnap.js';
import { boxes, figureFrame, figureOf, fitSize } from '../../server/src/cld/hdSheet.js';

const root = path.resolve(__dirname, '../..');
const SRC_NEAR = path.join(root, '../specs/owner-art-1025');
const SOURCES = fs.existsSync(SRC_NEAR)
  ? SRC_NEAR
  : path.resolve(root, '.worktrees/specs/owner-art-1025');
export const OUT = path.join(root, 'cld/artifacts/hd64');

/** Density 4: 64×128 frames, the feet on row 123 (the classic row 30). */
export const D = 4;
export const FW = 16 * D;
export const FH = 32 * D;
export const FLOOR = 31 * D - 1;
export const VIEWS = ['down', 'up', 'right'] as const;
export type View = (typeof VIEWS)[number];
export const FRAMES = 7;

/** The owner's poses per view (1-based boxes of the example's row) that form the walk cycle the
 *  office plays (walk1, walk2, walk3, walk2): walk2 the standing pose, walk1 and walk3 a foot off
 *  the ground on either side. The example's side row faces left: mirrored. */
/** The standing figure's height in the frame (from the ears' tips to the floor). */
const FIGURE_ROWS = 116;
const WALK: Record<View, [number, number, number]> = {
  down: [2, 1, 6],
  up: [2, 1, 6],
  right: [3, 7, 6],
};

// ── images ────────────────────────────────────────────────────────────────────────────────────

export interface Img {
  w: number;
  h: number;
  data: Uint8Array;
}
export const blank = (w = FW, h = FH): Img => ({ w, h, data: new Uint8Array(w * h * 4) });
export const copy = (a: Img): Img => ({ w: a.w, h: a.h, data: new Uint8Array(a.data) });
export const at = (a: Img, x: number, y: number) =>
  x < 0 || y < 0 || x >= a.w || y >= a.h ? -1 : (y * a.w + x) * 4;
export const on = (a: Img, x: number, y: number) => {
  const o = at(a, x, y);
  return o >= 0 && a.data[o + 3] > 0;
};
export const get = (a: Img, x: number, y: number): number[] | null => {
  const o = at(a, x, y);
  return o >= 0 && a.data[o + 3] ? [a.data[o], a.data[o + 1], a.data[o + 2]] : null;
};
export const put = (a: Img, x: number, y: number, c: readonly number[] | null) => {
  const o = at(a, x, y);
  if (o < 0) return;
  if (c) a.data.set([c[0], c[1], c[2], 255], o);
  else a.data.fill(0, o, o + 4);
};
/** `b` drawn over `a` at (dx, dy). */
export function over(a: Img, b: Img, dx = 0, dy = 0) {
  for (let y = 0; y < b.h; y++)
    for (let x = 0; x < b.w; x++) {
      const c = get(b, x, y);
      if (c) put(a, x + dx, y + dy, c);
    }
}
export const read = (file: string): Rgba => {
  const p = PNG.sync.read(fs.readFileSync(file));
  return { width: p.width, height: p.height, data: new Uint8Array(p.data) };
};
export function writePng(file: string, a: Img) {
  const p = new PNG({ width: a.w, height: a.h });
  p.data = Buffer.from(a.data);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, PNG.sync.write(p));
}
/** `a` enlarged `z` times on a dark floor colour. */
export function zoomed(a: Img, z: number, bg = [32, 32, 40]): Img {
  const out = blank(a.w * z, a.h * z);
  for (let y = 0; y < out.h; y++)
    for (let x = 0; x < out.w; x++)
      put(out, x, y, get(a, Math.floor(x / z), Math.floor(y / z)) ?? bg);
  return out;
}
/** Images side by side, top-aligned, `gap` px apart. */
export function strip(imgs: Img[], gap = 8, bg = [20, 20, 26]): Img {
  const out = blank(
    imgs.reduce((t, i) => t + i.w, 0) + gap * (imgs.length + 1),
    Math.max(...imgs.map((i) => i.h)) + gap * 2,
  );
  for (let y = 0; y < out.h; y++) for (let x = 0; x < out.w; x++) put(out, x, y, bg);
  let x0 = gap;
  for (const i of imgs) {
    over(out, i, x0, gap);
    x0 += i.w + gap;
  }
  return out;
}
export const stack = (imgs: Img[], gap = 8): Img => {
  const out = blank(
    Math.max(...imgs.map((i) => i.w)),
    imgs.reduce((t, i) => t + i.h, 0) + gap * (imgs.length - 1),
  );
  let y0 = 0;
  for (const i of imgs) {
    over(out, i, 0, y0);
    y0 += i.h + gap;
  }
  return out;
};

const luma = (c: readonly number[]) => c[0] * 0.299 + c[1] * 0.587 + c[2] * 0.114;

// ── the owner's poses at density 4 ────────────────────────────────────────────────────────────

/** Every pose of the example per view, 64×128, the feet on the floor, centred; one scale per view
 *  (the generator drew the side row 8% smaller: each view stands its tallest figure in the frame). */
export function poses(): Record<View, Img[]> {
  const ex = read(path.join(SOURCES, 'hd-bunny-sheet-example.png'));
  const found = boxes(ex);
  const figs = found.map((b) => figureOf(ex, b)!);
  const out = {} as Record<View, Img[]>;
  VIEWS.forEach((view, r) => {
    const row = figs.slice(r * 7, r * 7 + 7);
    // the tallest figure stands FIGURE_ROWS tall (the ears 4 px under the walk2 head canvas's top)
    const rows = FIGURE_ROWS;
    const size = Math.max(...row.map((f) => Math.max(fitSize(f, D), (f[3] - f[1]) / rows)));
    out[view] = row.map((f) => {
      const one = figureFrame(ex, f, size, {
        density: D,
        mirror: view === 'right',
        interiorDarkShare: 0.5,
      });
      if ('error' in one) throw new Error(one.error);
      return { w: one.w, h: one.h, data: one.data };
    });
  });
  return out;
}

// ── parts by colour and place ─────────────────────────────────────────────────────────────────

export const PARTS = [
  'body',
  'face',
  'hair',
  'fullbody',
  'legwear',
  'shoes',
  'wrist',
  'neck',
  'back',
] as const;
export type Part = (typeof PARTS)[number];

/** Height bands (share of the figure from its top): ears, the head to the chin, the hair's ends,
 *  the bow tie, the suit's leg line, the heels; the tail's band and the cuffs'. */
const BAND = {
  ears: 0.2,
  chin: 0.46,
  hairEnd: 0.53,
  bow: 0.56,
  legs: 0.62,
  suitEnd: 0.8,
  heels: 0.9,
};
const BARE_SKIN = 170;
const TAIL = [0.56, 0.74];
const CUFF = [0.6, 0.76];
const isSkin = (c: readonly number[]) =>
  c[0] > 150 && c[0] - c[1] >= 12 && c[1] >= c[2] - 4 && c[0] - c[2] >= 30 && luma(c) > 120;
const isLight = (c: readonly number[]) => luma(c) >= 150 && Math.max(...c) - Math.min(...c) <= 40;
const isDark = (c: readonly number[]) => luma(c) < 80;

/** Each pixel of a frame given its part. `figTop`: the figure's top row (its standing height). */
export function labels(f: Img, view: View): Int8Array {
  const lab = new Int8Array(f.w * f.h).fill(-1);
  let [x0, y0, x1, y1] = [f.w, f.h, 0, 0];
  for (let y = 0; y < f.h; y++)
    for (let x = 0; x < f.w; x++)
      if (on(f, x, y))
        [x0, y0, x1, y1] = [
          Math.min(x0, x),
          Math.min(y0, y),
          Math.max(x1, x + 1),
          Math.max(y1, y + 1),
        ];
  const H = y1 - y0;
  const W = x1 - x0;
  // the face: skin inside the head band
  let [fx0, fy0, fx1, fy1] = [f.w, f.h, -1, -1];
  for (let y = y0; y < y0 + H * BAND.chin; y++)
    for (let x = x0; x < x1; x++) {
      const c = get(f, x, y);
      if (c && isSkin(c))
        [fx0, fy0, fx1, fy1] = [
          Math.min(fx0, x),
          Math.min(fy0, y),
          Math.max(fx1, x),
          Math.max(fy1, y),
        ];
    }
  const id = (p: Part) => PARTS.indexOf(p);
  const darkAround = (x: number, y: number) => {
    let n = 0;
    for (let dy = -2; dy <= 2; dy++)
      for (let dx = -2; dx <= 2; dx++) {
        const c = get(f, x + dx, y + dy);
        if (c && isDark(c)) n++;
      }
    return n;
  };
  const outlines: number[] = [];
  for (let y = 0; y < f.h; y++)
    for (let x = 0; x < f.w; x++) {
      const c = get(f, x, y);
      if (!c) continue;
      const t = (y - y0) / H;
      const u = (x - x0) / W;
      const off = Math.abs(u - 0.5);
      // through sheer tights the legs read warm too: bare skin there (the hands) is bright
      const skin = isSkin(c) && (t < BAND.legs || luma(c) > BARE_SKIN);
      const light = isLight(c);
      const dark = isDark(c);
      const material = dark && darkAround(x, y) >= 15;
      const inFace = view !== 'up' && x >= fx0 && x <= fx1 && y >= fy0 && y <= fy1;
      const belowFringe = y > fy0 + (fy1 - fy0) * 0.3;
      // the tail is on the back: the middle from behind, the left from the side (she faces right)
      const tailSide = view === 'up' ? off < 0.2 : view === 'right' && u < 0.45;
      let p: Part | null;
      if (t < BAND.chin) {
        if (skin) p = 'body';
        else if (inFace && (belowFringe || !light)) p = dark && !belowFringe ? null : 'face';
        else p = dark && t > BAND.ears && !material ? null : 'hair';
      } else if (skin) p = 'body';
      else if (light && view !== 'down' && tailSide && t >= TAIL[0] && t < TAIL[1]) p = 'back';
      else if (light && t < BAND.hairEnd && (view === 'up' || off > 0.16 || view === 'right'))
        p = 'hair';
      else if (light && t >= CUFF[0] && t < CUFF[1]) p = 'wrist';
      else if (dark && t < BAND.bow && off < 0.16 && view !== 'up') p = 'neck';
      else if (t < BAND.hairEnd && !(dark && off < 0.16 && view !== 'up')) p = 'hair';
      else if (dark && !material) p = null;
      else if (dark && t >= BAND.heels) p = 'shoes';
      else if (dark && t < BAND.suitEnd) p = 'fullbody';
      else if (light) p = 'fullbody';
      else p = t < BAND.bow + 0.1 ? 'fullbody' : 'legwear';
      if (p) lab[y * f.w + x] = id(p);
      else outlines.push(x, y);
    }
  // an outline belongs to what it outlines: the most common part around it
  for (let pass = 0; pass < 4 && outlines.length; pass++) {
    const left: number[] = [];
    const set: [number, number][] = [];
    for (let k = 0; k < outlines.length; k += 2) {
      const [x, y] = [outlines[k], outlines[k + 1]];
      const votes = new Array(PARTS.length).fill(0);
      for (let dy = -2; dy <= 2; dy++)
        for (let dx = -2; dx <= 2; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= f.w || yy >= f.h) continue;
          const l = lab[yy * f.w + xx];
          if (l >= 0) votes[l]++;
        }
      const best = Math.max(...votes);
      if (best) set.push([y * f.w + x, votes.indexOf(best)]);
      else left.push(x, y);
    }
    for (const [i, l] of set) lab[i] = l;
    outlines.splice(0, outlines.length, ...left);
  }
  for (let k = 0; k < outlines.length; k += 2)
    lab[outlines[k + 1] * f.w + outlines[k]] = id('body');
  return lab;
}

/** A colour per part, for the label pictures. */
export const PART_COLOURS: Record<Part, number[]> = {
  body: [240, 190, 150],
  face: [230, 60, 60],
  hair: [120, 200, 255],
  fullbody: [60, 60, 200],
  legwear: [140, 100, 60],
  shoes: [250, 230, 40],
  wrist: [255, 255, 255],
  neck: [255, 120, 220],
  back: [80, 240, 120],
};
export function labelPicture(lab: Int8Array, w = FW, h = FH): Img {
  const out = blank(w, h);
  lab.forEach((l, i) => l >= 0 && put(out, i % w, Math.floor(i / w), PART_COLOURS[PARTS[l]]));
  return out;
}

/** The head anchors at density 4 (char_0's, classic px: walk bob, seated): frame f's head canvas
 *  starts at row y × 4 of its anchor (the compositor's rule). */
export const anchorRow = (view: View, f: number) =>
  PARTS_META.headAnchors[VIEWS.indexOf(view) * FRAMES + f][1] * D;

/** A frame enlarged `z` times with a grid every 8 px (every 32 px brighter): for measuring. */
export function gridded(a: Img, z: number): Img {
  const out = zoomed(a, z);
  for (let y = 0; y < out.h; y++)
    for (let x = 0; x < out.w; x++) {
      const sx = Math.floor(x / z);
      const sy = Math.floor(y / z);
      if ((x % z === 0 && sx % 8 === 0) || (y % z === 0 && sy % 8 === 0))
        put(
          out,
          x,
          y,
          sx % 32 === 0 && x % z === 0
            ? [255, 0, 0]
            : sy % 32 === 0 && y % z === 0
              ? [255, 0, 0]
              : [0, 140, 140],
        );
    }
  return out;
}

// ── the frames ────────────────────────────────────────────────────────────────────────────────

const OUTLINE = [36, 24, 32];
type Rect = [number, number, number, number];

/** The pixels of `f` inside `r` whose part is one of `parts` (all parts when empty), lifted out of
 *  `f` (they are erased there) into a piece of the frame's size. */
function lift(f: Img, lab: Int8Array, r: Rect, parts: Part[] = []): Img {
  const piece = blank(f.w, f.h);
  for (let y = r[1]; y < r[3]; y++)
    for (let x = r[0]; x < r[2]; x++) {
      const c = get(f, x, y);
      const l = lab[y * f.w + x];
      if (!c || (parts.length && !parts.includes(PARTS[l]))) continue;
      put(piece, x, y, c);
      put(f, x, y, null);
    }
  return piece;
}
const moved = (p: Img, dx: number, dy: number): Img => {
  const out = blank(p.w, p.h);
  over(out, p, dx, dy);
  return out;
};
/** Re-posed pieces get their outline back: a drawn edge pixel (an empty 4-neighbour) that is not
 *  dark takes the outline colour; a one-pixel gap inside the figure is filled from its row. */
function repair(f: Img, only: Img | null = null) {
  const n4 = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];
  const fill: [number, number, number[]][] = [];
  for (let y = 0; y < f.h; y++)
    for (let x = 0; x < f.w; x++) {
      const c = get(f, x, y);
      if (!c) {
        // a hole: drawn left and right, or above and below
        const l = get(f, x - 1, y);
        const r = get(f, x + 1, y);
        const u = get(f, x, y - 1);
        const d = get(f, x, y + 1);
        if ((l && r) || (u && d)) fill.push([x, y, l && r ? l : u!]);
        continue;
      }
      if (only && !on(only, x, y)) continue;
      if (n4.some(([dx, dy]) => !on(f, x + dx, y + dy)) && luma(c) >= 80)
        fill.push([x, y, OUTLINE]);
    }
  for (const [x, y, c] of fill) put(f, x, y, c);
  // specks a re-posed limb left behind (a few pixels apart from the figure) go
  const seen = new Uint8Array(f.w * f.h);
  for (let s0 = 0; s0 < f.w * f.h; s0++) {
    if (seen[s0] || !f.data[s0 * 4 + 3]) continue;
    const piece = [s0];
    seen[s0] = 1;
    for (let k = 0; k < piece.length; k++) {
      const [x, y] = [piece[k] % f.w, Math.floor(piece[k] / f.w)];
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const j = (y + dy) * f.w + x + dx;
          if (on(f, x + dx, y + dy) && !seen[j]) {
            seen[j] = 1;
            piece.push(j);
          }
        }
    }
    if (piece.length <= SPECK) for (const j of piece) f.data.fill(0, j * 4, j * 4 + 4);
  }
}
const SPECK = 12;
const NECK = 3;

/** One view's 7 frames: the walk from the owner's poses (each aligned on the standing head, which
 *  every frame wears at its head anchor), the seated frames re-posed from the standing one. */
export function viewFrames(
  view: View,
  all: Img[],
  expr: Expression = 'neutral',
): { frames: Img[]; head: Img; labs: Int8Array[]; labS: Int8Array } {
  const S = all[WALK[view][1] - 1];
  const labS = labels(S, view);
  const top = Math.floor(S.data.findIndex((v, i) => i % 4 === 3 && v > 0) / 4 / S.w);
  // the head keeps its neck down to the collar: the walk poses join under it
  const chin = Math.floor(top + (FLOOR - top) * BAND.chin) + NECK;
  const isHead = (lab: Int8Array, chinRow: number) => (x: number, y: number) => {
    const p = PARTS[lab[y * S.w + x]];
    return p === 'hair' || p === 'face' || (p === 'body' && y < chinRow);
  };
  // the head: hair, face and the head's skin of the standing frame
  const head = blank();
  const headOfS = isHead(labS, chin);
  for (let y = 0; y < S.h; y++)
    for (let x = 0; x < S.w; x++) if (on(S, x, y) && headOfS(x, y)) put(head, x, y, get(S, x, y));
  if (view !== 'up') face(head, labS, view, expr);
  const bodyOf = (P: Img, lab: Int8Array, chinRow: number) => {
    const b = copy(P);
    const h = isHead(lab, chinRow);
    for (let y = 0; y < P.h; y++)
      for (let x = 0; x < P.w; x++) if (on(P, x, y) && h(x, y)) put(b, x, y, null);
    return b;
  };
  const frames: Img[] = [];
  const labs: Int8Array[] = [];
  const g = GEOMETRY[view];
  for (let f = 0; f < FRAMES; f++) {
    const oy = anchorRow(view, f) - anchorRow(view, 1);
    let body: Img;
    if (f < 3) {
      const P = all[WALK[view][f] - 1];
      const labP = labels(P, view);
      // where the standing head sits in this pose: the pose's head is everything above its chin
      const [dx, dy] = match(head, P);
      body = moved(bodyOf(P, labP, chin + dy), -dx, oy - dy);
    } else body = seated(view, f, bodyOf(S, labS, chin), labS, g, oy);
    const frame = blank();
    over(frame, body);
    over(frame, moved(head, 0, oy));
    repair(frame);
    frames.push(frame);
    labs.push(labels(frame, view));
  }
  return { frames, head, labs, labS };
}

// ── faces ─────────────────────────────────────────────────────────────────────────────────────

export const EXPRESSIONS = ['neutral', 'smile', 'wink'] as const;
export type Expression = (typeof EXPRESSIONS)[number];
/** The standing head's eyes and mouth (64×128 px, measured): the eye a wink closes (her left: the
 *  viewer's right from the front, the one we see from the side) and the mouth's box. */
const FACE: Record<'down' | 'right', { wink: Rect; mouth: Rect; arc: [number, number, number] }> = {
  down: { wink: [34, 47, 45, 58], mouth: [28, 57, 38, 62], arc: [35, 43, 52] },
  right: { wink: [39, 47, 48, 57], mouth: [46, 57, 52, 62], arc: [40, 46, 52] },
};
const MOUTH = [158, 72, 82];
const SKIN_NEAR = 30;
/** The expression drawn at the eye and mouth pixels: neutral a short flat mouth, smile a curved
 *  one, wink the eye closed to an arched line (the smile's mouth with it). */
function face(head: Img, lab: Int8Array, view: 'down' | 'right', expr: Expression) {
  const geo = FACE[view];
  // the face's skin: its most common skin colour
  const counts = new Map<string, number>();
  for (let y = geo.mouth[1] - 8; y < geo.mouth[3]; y++)
    for (let x = geo.mouth[0] - 6; x < geo.mouth[2] + 2; x++) {
      const c = get(head, x, y);
      if (c && isSkin(c)) counts.set(c.join(), (counts.get(c.join()) ?? 0) + 1);
    }
  const skin = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])[0][0]
    .split(',')
    .map(Number);
  // what is not (nearly) the skin colour in the box goes: the old mouth or eye, its blended edge
  const erase = (r: Rect) => {
    for (let y = r[1]; y < r[3]; y++)
      for (let x = r[0]; x < r[2]; x++) {
        const c = get(head, x, y);
        const p = PARTS[lab[y * FW + x]];
        const far = c && Math.hypot(c[0] - skin[0], c[1] - skin[1], c[2] - skin[2]) > SKIN_NEAR;
        if (far && (p === 'face' || p === 'body')) put(head, x, y, skin);
      }
  };
  erase(geo.mouth);
  const [mx0, my0, mx1] = geo.mouth;
  const mid = Math.floor((mx0 + mx1) / 2);
  const my = my0 + 2;
  if (expr === 'neutral')
    for (let x = mid - 1; x <= mid + (view === 'down' ? 1 : 0); x++) put(head, x, my, MOUTH);
  else {
    // a curve: the corners a pixel up
    // the corners a pixel up, wider than the neutral line
    const half = view === 'down' ? 4 : 2;
    for (let x = mid - half; x <= mid + half - 1; x++)
      put(head, x, x === mid - half || x === mid + half - 1 ? my - 1 : my, MOUTH);
  }
  if (expr === 'wink') {
    erase(geo.wink);
    const [x0, x1, y] = geo.arc;
    const c = (x0 + x1) / 2;
    const r = (x1 - x0) / 2;
    for (let x = x0; x <= x1; x++) {
      const yy = y - Math.round(2 * (1 - ((x - c) / r) ** 2));
      put(head, x, yy, OUTLINE);
      // thicker in the middle: it reads as a closed eye, not a crease
      if (Math.abs(x - c) < r - 1) put(head, x, yy + 1, OUTLINE);
    }
  }
}

/** The offset (dx, dy) at which `head`'s pixels best match `P` (mean colour distance). */
function match(head: Img, P: Img): [number, number] {
  let best: [number, number, number] = [0, 0, Infinity];
  for (let dy = -12; dy <= 12; dy++)
    for (let dx = -6; dx <= 6; dx++) {
      let t = 0;
      let n = 0;
      for (let y = 0; y < head.h; y += 2)
        for (let x = 0; x < head.w; x += 2) {
          const c = get(head, x, y);
          if (!c) continue;
          const q = get(P, x + dx, y + dy);
          t += q ? Math.abs(c[0] - q[0]) + Math.abs(c[1] - q[1]) + Math.abs(c[2] - q[2]) : 255 * 3;
          n++;
        }
      if (t / n < best[2]) best = [dx, dy, t / n];
    }
  return [best[0], best[1]];
}

type Pt = [number, number];
/** A limb of the standing figure: the segment from its joint `a` to its end `b`, `w` px thick,
 *  inside `rect` (where its pixels are lifted from). */
interface Limb {
  rect: Rect;
  a: Pt;
  b: Pt;
  w: number;
}
/** Where the standing figure's limbs are, per view (64×128 px, measured on the standing frames):
 *  the forearms (elbow to the hand's end), the crotch row (the legs come off below it), the row the
 *  seated shins show from; the side view's thigh, shin and foot. */
interface Geometry {
  forearms: Limb[];
  crotch: number;
  shinsFrom: number;
  thigh?: Limb;
  shin?: Limb;
  foot?: Rect;
}
const GEOMETRY: Record<View, Geometry> = {
  down: {
    forearms: [
      { rect: [8, 79, 23, 99], a: [15, 80], b: [15, 98], w: 14 },
      { rect: [43, 79, 58, 99], a: [50, 80], b: [50, 98], w: 14 },
    ],
    crotch: 100,
    shinsFrom: 112,
  },
  up: {
    forearms: [
      { rect: [8, 79, 23, 99], a: [15, 80], b: [15, 98], w: 14 },
      { rect: [43, 79, 58, 99], a: [50, 80], b: [50, 98], w: 14 },
    ],
    crotch: 100,
    shinsFrom: 112,
  },
  right: {
    forearms: [{ rect: [31, 79, 47, 99], a: [38, 80], b: [40, 98], w: 13 }],
    crotch: 99,
    shinsFrom: 108,
    thigh: { rect: [34, 96, 50, 110], a: [40, 97], b: [46, 109], w: 13 },
    shin: { rect: [40, 106, 56, 120], a: [46, 107], b: [51, 119], w: 10 },
    foot: [40, 113, 61, 125],
  },
};

/** `limb`'s pixels (in `src`) re-posed onto the segment `a`→`b`: each pixel of the new limb takes
 *  the nearest pixel at the same place along and across the old one (no smoothing; its shading
 *  turns with it). `stretch` < 1 foreshortens along the limb. */
function repose(src: Img, limb: Limb, a: Pt, b: Pt): Img {
  const out = blank();
  const [ax, ay] = limb.a;
  const [ux, uy] = [limb.b[0] - ax, limb.b[1] - ay];
  const len0 = Math.hypot(ux, uy);
  const [vx, vy] = [b[0] - a[0], b[1] - a[1]];
  const len1 = Math.hypot(vx, vy);
  const half = limb.w / 2 + 1;
  for (let y = 0; y < FH; y++)
    for (let x = 0; x < FW; x++) {
      // along (0..1, a little past the ends for the round tips) and across the new segment
      const t = ((x + 0.5 - a[0]) * vx + (y + 0.5 - a[1]) * vy) / (len1 * len1);
      const s = ((x + 0.5 - a[0]) * -vy + (y + 0.5 - a[1]) * vx) / len1;
      const tip = half / Math.max(1, len1);
      if (t < -tip || t > 1 + tip || Math.abs(s) > half) continue;
      const sx = ax + t * ux + (s * -uy) / len0;
      const sy = ay + t * uy + (s * ux) / len0;
      put(out, x, y, get(src, Math.floor(sx), Math.floor(sy)));
    }
  return out;
}

/** A seated frame re-posed from the standing body `b` (head removed): typing (frames 3, 4) with
 *  the hands at a keyboard in two places, reading (5, 6) with the arms raised to the paper. */
function seated(view: View, f: number, b0: Img, lab: Int8Array, g: Geometry, oy: number): Img {
  const b = copy(b0);
  const typing = f < 5;
  const alt = f % 2 === 1 ? 1 : -1; // type1 / read1: the left hand up, type2 / read2: the right
  // the forearms come off (skin and cuffs only), the legs below the crotch come off
  const arms = g.forearms.map((l) => lift(b, lab, l.rect, ['body', 'wrist']));
  const legs = lift(b, lab, [0, g.crotch, FW, FH]);
  const out = blank();
  if (view === 'right') {
    // the thigh forward from the hip, the shin down from the knee, the foot under it
    const hip: Pt = [g.thigh!.a[0] - 4, g.crotch - 4 + oy];
    const knee: Pt = [hip[0] + 13, hip[1] + 1];
    const ankle: Pt = [knee[0] + 1, knee[1] + 13];
    over(out, moved(cutRect(legs, g.foot!), ankle[0] - 46, ankle[1] - 117));
    over(out, repose(legs, g.shin!, [knee[0] - 1, knee[1] + 2], ankle));
    over(out, repose(legs, g.thigh!, hip, knee));
  } else {
    // facing or turned away: the thighs foreshortened away, the shins and feet below the knees
    const shins = moved(cutRect(legs, [0, g.shinsFrom, FW, FH]), 0, g.crotch + oy - g.shinsFrom);
    over(out, shins);
  }
  over(out, moved(b, 0, oy));
  // the paper's place in this frame (the app draws it over the reading frames)
  g.forearms.forEach((l, i) => {
    const elbow: Pt = [l.a[0], l.a[1] + oy];
    const up = alt * (i === 0 ? 1 : -1) > 0 ? 2 : 0;
    let hand: Pt;
    if (view === 'right')
      // forward to the keyboard, or forward and up to the paper's edge
      hand = typing ? [elbow[0] + 15, elbow[1] + 3 - up * 1.5] : [elbow[0] + 11, elbow[1] - 2 - up];
    else {
      const inward = i === 0 ? 1 : -1;
      // facing: the forearm toward the desk (shorter: it points at us); reading: up to the paper's side
      hand = typing
        ? [elbow[0] + inward * (view === 'down' ? 7 : 5), elbow[1] + 11 - up * 1.5]
        : [elbow[0] + inward * 3, elbow[1] + 8 - up - (view === 'down' ? 0 : 4)];
    }
    over(out, repose(arms[i], l, elbow, hand));
  });
  repair(out);
  return out;
}
const cutRect = (p: Img, r: Rect): Img => {
  const out = blank(p.w, p.h);
  for (let y = r[1]; y < r[3]; y++) for (let x = r[0]; x < r[2]; x++) put(out, x, y, get(p, x, y));
  return out;
};

if (require.main === module && process.argv[2] === 'debug') {
  const all = poses();
  for (const view of VIEWS) {
    const { frames } = viewFrames(view, all[view]);
    writePng(path.join('/tmp/hd64', `frames-${view}.png`), zoomed(strip(frames, 4), 3));
  }
  const heads = (['down', 'right'] as const).flatMap((v) =>
    EXPRESSIONS.map((e) => {
      const h = viewFrames(v, all[v], e).head;
      const c = blank(40, 32);
      over(c, h, v === 'down' ? -12 : -20, -36);
      return zoomed(c, 8);
    }),
  );
  writePng('/tmp/hd64/faces.png', strip(heads));
}

/** Three views of seven frames as a 448×384 sheet (rows down, up, right). */
export function sheetOf(rows: Record<View, Img[]>): Img {
  const out = blank(FW * FRAMES, FH * 3);
  VIEWS.forEach((v, r) => rows[v].forEach((f, i) => over(out, f, i * FW, r * FH)));
  return out;
}

/** Step 1's pictures: the master sheet, the owner's poses each walk frame came from, the standing
 *  frame each seated frame was re-posed from, the faces. */
export function writeMaster() {
  const all = poses();
  const rows = {} as Record<View, Img[]>;
  const picks: Img[] = [];
  for (const view of VIEWS) {
    rows[view] = viewFrames(view, all[view]).frames;
    // the owner's pose above each walk frame; the standing pose above the seated ones
    const src = [0, 1, 2, 1, 1, 1, 1].map((k) => all[view][WALK[view][k] - 1]);
    picks.push(stack([strip(src, 4), strip(rows[view], 4)], 4));
  }
  writePng(path.join(OUT, 'master-64x128.png'), sheetOf(rows));
  writePng(path.join(OUT, 'master-64x128-x3.png'), zoomed(sheetOf(rows), 3));
  writePng(path.join(OUT, 'master-from-source.png'), zoomed(stack(picks, 12), 2));
  for (const e of EXPRESSIONS) {
    if (e === 'neutral') continue;
    const r = {} as Record<View, Img[]>;
    for (const view of VIEWS) r[view] = viewFrames(view, all[view], e).frames;
    writePng(path.join(OUT, `master-64x128-${e}.png`), sheetOf(r));
  }
  const heads = (['down', 'right'] as const).flatMap((v) =>
    EXPRESSIONS.map((e) => {
      const h = viewFrames(v, all[v], e).head;
      const c = blank(40, 40);
      over(c, h, v === 'down' ? -12 : -18, -32);
      return zoomed(c, 6);
    }),
  );
  writePng(path.join(OUT, 'faces-neutral-smile-wink.png'), strip(heads));
}

// ── parts (step 2) ────────────────────────────────────────────────────────────────────────────

export const PACK_DIR = path.join(root, 'cld/packs/hd-bunny');
const SHEET_PARTS = ['body', 'fullbody', 'legwear', 'shoes', 'wrist', 'neck', 'back'] as const;
type SheetPart = (typeof SHEET_PARTS)[number];
const HEAD_W = PARTS_META.headBox.w * D;
const HEAD_H = PARTS_META.headBox.h * D;
/** Under the clothes the body is skin (its main colour), so another outfit shows a body. */
const UNDER: Part[] = ['fullbody', 'legwear', 'shoes', 'wrist', 'neck'];

/** The master split into its parts at 64×128: the sheet parts (each 448×384, from every frame's
 *  own pixels outside the head) and the head parts (hair, and the face per expression; 192×96 head
 *  canvases, cut at the standing frame's head anchor). */
export function buildParts() {
  const all = poses();
  const sheets = Object.fromEntries(
    SHEET_PARTS.map((p) => [p, blank(FW * FRAMES, FH * 3)]),
  ) as Record<SheetPart, Img>;
  const hair = blank(HEAD_W * 3, HEAD_H);
  const faces = Object.fromEntries(
    EXPRESSIONS.map((e) => [e, blank(HEAD_W * 3, HEAD_H)]),
  ) as Record<Expression, Img>;
  VIEWS.forEach((view, r) => {
    const vf = viewFrames(view, all[view]);
    const S = all[view][WALK[view][1] - 1];
    const R1 = anchorRow(view, 1);
    const part = (x: number, y: number) => PARTS[vf.labS[y * FW + x]];
    for (let cy = 0; cy < HEAD_H; cy++)
      for (let cx = 0; cx < HEAD_W; cx++) {
        const y = R1 + cy;
        if (part(cx, y) === 'hair') put(hair, r * HEAD_W + cx, cy, get(vf.head, cx, y));
      }
    if (view !== 'up')
      for (const e of EXPRESSIONS) {
        const h = viewFrames(view, all[view], e).head;
        for (let cy = 0; cy < HEAD_H; cy++)
          for (let cx = 0; cx < HEAD_W; cx++) {
            const y = R1 + cy;
            const c = get(h, cx, y);
            const was = get(S, cx, y);
            // the face's own pixels, and every pixel the expression redrew
            const edited = c && (!was || c.join() !== was.join());
            if (c && (part(cx, y) === 'face' || edited)) put(faces[e], r * HEAD_W + cx, cy, c);
          }
      }
    const skin = mainSkin(S, vf.labS);
    vf.frames.forEach((frame, f) => {
      const oy = anchorRow(view, f) - anchorRow(view, 1);
      const head = moved(vf.head, 0, oy);
      const lab = labels(frame, view);
      const [ox, oyy] = [f * FW, r * FH];
      const fill = blank();
      for (let y = 0; y < FH; y++)
        for (let x = 0; x < FW; x++) {
          const c = get(frame, x, y);
          if (!c) continue;
          if (on(head, x, y)) {
            // the head's skin is the body's; under the face too
            const p = PARTS[vf.labS[(y - oy) * FW + x]];
            if (p === 'body') put(sheets.body, ox + x, oyy + y, get(head, x, y));
            else if (p === 'face') put(fill, x, y, skin);
            continue;
          }
          const p = PARTS[lab[y * FW + x]];
          if (p === 'hair' || p === 'face') continue;
          put(sheets[p as SheetPart], ox + x, oyy + y, c);
          if (UNDER.includes(p)) put(fill, x, y, skin);
        }
      // the skin under the clothes, its edge outlined, under the visible skin
      for (let y = 0; y < FH; y++)
        for (let x = 0; x < FW; x++) {
          if (!on(fill, x, y) || on(sheets.body, ox + x, oyy + y)) continue;
          const edge = [
            [1, 0],
            [-1, 0],
            [0, 1],
            [0, -1],
          ].some(([dx, dy]) => !on(frame, x + dx, y + dy));
          put(sheets.body, ox + x, oyy + y, edge ? OUTLINE : skin);
        }
    });
  });
  return { sheets, hair, faces };
}

function mainSkin(S: Img, lab: Int8Array): number[] {
  const counts = new Map<string, number>();
  for (let i = 0; i < lab.length; i++) {
    const c = get(S, i % FW, Math.floor(i / FW));
    if (c && PARTS[lab[i]] === 'body' && isSkin(c))
      counts.set(c.join(), (counts.get(c.join()) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])[0][0]
    .split(',')
    .map(Number);
}

/** At most `max` colours (the part format's limit): weighted k-means over the colours used, seeded
 *  with the commonest and the farthest, so a small accent (an ear's shine) keeps its own colour. */
export function quantize(a: Img, max = 62): Img {
  const counts = new Map<string, number>();
  for (let i = 0; i < a.w * a.h; i++)
    if (a.data[i * 4 + 3]) {
      const k = [...a.data.subarray(i * 4, i * 4 + 3)].join();
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
  if (counts.size <= max) return a;
  const cols = [...counts.entries()].map(([k, n]) => ({ c: k.split(',').map(Number), n }));
  const d2 = (p: number[], q: number[]) =>
    (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2;
  // seeds: half the commonest, then each next the colour farthest from those chosen
  const centres = [...cols]
    .sort((p, q) => q.n - p.n)
    .slice(0, max / 2)
    .map((e) => e.c);
  while (centres.length < max) {
    let far = cols[0].c;
    let fd = -1;
    for (const e of cols) {
      const d = Math.min(...centres.map((c) => d2(e.c, c)));
      if (d > fd) [far, fd] = [e.c, d];
    }
    centres.push(far);
  }
  const nearest = (c: number[]) => {
    let k = 0;
    let bd = Infinity;
    centres.forEach((q, i) => {
      const d = d2(c, q);
      if (d < bd) [k, bd] = [i, d];
    });
    return k;
  };
  for (let it = 0; it < KMEANS_ROUNDS; it++) {
    const sum = centres.map(() => [0, 0, 0, 0]);
    for (const e of cols) {
      const k = nearest(e.c);
      for (let j = 0; j < 3; j++) sum[k][j] += e.c[j] * e.n;
      sum[k][3] += e.n;
    }
    sum.forEach((s, k) => s[3] && (centres[k] = s.slice(0, 3).map((v) => Math.round(v / s[3]))));
  }
  const map = new Map(cols.map((e) => [e.c.join(), centres[nearest(e.c)]]));
  const out = copy(a);
  for (let i = 0; i < a.w * a.h; i++)
    if (a.data[i * 4 + 3])
      out.data.set(map.get([...a.data.subarray(i * 4, i * 4 + 3)].join())!, i * 4);
  return out;
}
const KMEANS_ROUNDS = 8;
/** The recolour shown in the composites: the suit in red. */
// eslint-disable-next-line pixel-agents/no-inline-colors -- a part colour the demo picks
const RED_SUIT = '#b02040';

/** The classic copy of a 64×128 part, drawn by rule from it (step 3 replaces it with the
 *  hand-tuned one): each classic pixel the most common colour of its 4×4 block, drawn when half
 *  the block is. */
export function classicOf4(a: Img): Img {
  const out = blank(a.w / D, a.h / D);
  for (let y = 0; y < out.h; y++)
    for (let x = 0; x < out.w; x++) {
      const counts = new Map<string, number>();
      let n = 0;
      for (let dy = 0; dy < D; dy++)
        for (let dx = 0; dx < D; dx++) {
          const c = get(a, x * D + dx, y * D + dy);
          if (!c) continue;
          n++;
          counts.set(c.join(), (counts.get(c.join()) ?? 0) + 1);
        }
      if (n * 2 >= D * D)
        put(
          out,
          x,
          y,
          [...counts.entries()]
            .sort((p, q) => q[1] - p[1])[0][0]
            .split(',')
            .map(Number),
        );
    }
  return out;
}

// ── the hand-tuned 16×32 (step 3) ─────────────────────────────────────────────────────────────

/** Per part: how many flat tones its 16×32 drawing keeps (picked along its own lightness), and
 *  whether its silhouette gets the outline. The suit, the tights, the heels, the cuffs, the bow tie
 *  read as clear colour areas; the hair keeps its shine and the ears their black. */
const TONES: Record<string, { tones: number; outline: boolean }> = {
  body: { tones: 2, outline: true },
  hair: { tones: 4, outline: false },
  suit: { tones: 2, outline: false },
  tights: { tones: 2, outline: true },
  heels: { tones: 1, outline: false },
  cuffs: { tones: 2, outline: false },
  bowtie: { tones: 1, outline: false },
  tail: { tones: 2, outline: true },
};

/** `k` tones of a colour list: groups along lightness (1-D k-means, weighted by use), each tone its
 *  group's mean colour. */
function tonesOf(cols: number[][], k: number): number[][] {
  const L = cols.map(luma);
  let centres = Array.from({ length: k }, (_, i) => L[Math.floor(((i + 0.5) * L.length) / k)]);
  let groups: number[][][] = [];
  for (let it = 0; it < 12; it++) {
    groups = centres.map(() => []);
    cols.forEach((c, i) => {
      let best = 0;
      centres.forEach((m, j) => Math.abs(L[i] - m) < Math.abs(L[i] - centres[best]) && (best = j));
      groups[best].push(c);
    });
    centres = groups.map((g, j) =>
      g.length ? g.reduce((t, c) => t + luma(c), 0) / g.length : centres[j],
    );
  }
  return groups
    .filter((g) => g.length)
    .map((g) => [0, 1, 2].map((ch) => Math.round(g.reduce((t, c) => t + c[ch], 0) / g.length)));
}

/** The 16×32 drawing of a part, for legibility rather than by halving: its shape from the 4×4
 *  blocks, its colours flattened to a few of its own tones, the silhouette outlined; the face drawn
 *  at its eye and mouth pixels (two-pixel eyes with a light pixel each, the wink a closed line, the
 *  smile two pixels). */
export function handTuned(id: string, art: Img): Img {
  if (id.startsWith('face-')) return classicFace(id.slice('face-'.length) as Expression);
  const shape = classicOf4(art);
  const spec = TONES[id];
  if (!spec) return shape;
  const cols: number[][] = [];
  for (let i = 0; i < art.w * art.h; i++)
    if (art.data[i * 4 + 3]) cols.push([...art.data.subarray(i * 4, i * 4 + 3)]);
  cols.sort((a, b) => luma(a) - luma(b));
  const tones = tonesOf(cols, spec.tones);
  const out = blank(shape.w, shape.h);
  for (let y = 0; y < shape.h; y++)
    for (let x = 0; x < shape.w; x++) {
      const c = get(shape, x, y);
      if (!c) continue;
      let best = tones[0];
      for (const t of tones)
        if (Math.abs(luma(t) - luma(c)) < Math.abs(luma(best) - luma(c))) best = t;
      put(out, x, y, best);
    }
  if (spec.outline)
    for (let y = 0; y < shape.h; y++)
      for (let x = 0; x < shape.w; x++) {
        if (!on(shape, x, y)) continue;
        // per frame (a 16×32 cell, or a 16×24 head view): the cell's edge is not the outline
        const cell = (xx: number, yy: number) =>
          Math.floor(xx / 16) === Math.floor(x / 16) && on(shape, xx, yy);
        if (
          [
            [1, 0],
            [-1, 0],
            [0, 1],
            [0, -1],
          ].some(([dx, dy]) => !cell(x + dx, y + dy))
        )
          put(out, x, y, OUTLINE);
      }
  return out;
}

/** Eyes and mouth on the classic head canvas (48×24: front, back, side), per expression. */
const CLASSIC_FACE = {
  down: { eyes: [5, 9], eyeRow: 11, mouth: [7, 14] },
  right: { eye: 10, eyeRow: 11, mouth: [12, 14] },
};
const IRIS = [92, 104, 120];
const EYE_SHINE = [235, 240, 250];
function classicFace(expr: Expression): Img {
  const out = blank(PARTS_META.headBox.w * 3, PARTS_META.headBox.h);
  const eye = (x: number, y: number, closed: boolean) => {
    if (closed) {
      // a closed eye: one dark line, a pixel wider
      put(out, x - 1, y + 1, OUTLINE);
      put(out, x, y + 1, OUTLINE);
      put(out, x + 1, y + 1, OUTLINE);
      return;
    }
    // two pixels wide, two tall: the lash line on top, the iris under it with its shine
    put(out, x, y, OUTLINE);
    put(out, x + 1, y, OUTLINE);
    put(out, x, y + 1, EYE_SHINE);
    put(out, x + 1, y + 1, IRIS);
  };
  const f = CLASSIC_FACE.down;
  eye(f.eyes[0], f.eyeRow, false);
  eye(f.eyes[1], f.eyeRow, expr === 'wink');
  const [mx, my] = f.mouth;
  if (expr === 'neutral') put(out, mx + 1, my, MOUTH);
  else {
    put(out, mx, my, MOUTH);
    put(out, mx + 1, my, MOUTH);
    put(out, mx + 2, my - 1, MOUTH);
    put(out, mx - 1, my - 1, MOUTH);
  }
  const r = CLASSIC_FACE.right;
  const ox = PARTS_META.headBox.w * 2;
  if (expr === 'wink') {
    put(out, ox + r.eye, r.eyeRow + 1, OUTLINE);
    put(out, ox + r.eye + 1, r.eyeRow + 1, OUTLINE);
  } else {
    put(out, ox + r.eye, r.eyeRow, OUTLINE);
    put(out, ox + r.eye, r.eyeRow + 1, IRIS);
    put(out, ox + r.eye + 1, r.eyeRow, OUTLINE);
  }
  put(out, ox + r.mouth[0], r.mouth[1], MOUTH);
  if (expr !== 'neutral') put(out, ox + r.mouth[0] - 1, r.mouth[1] - 1, MOUTH);
  return out;
}

/** Part ids in the pack, their slots and names. */
const PACK_PARTS: {
  id: string;
  slot: string;
  from: SheetPart | 'hair' | 'face';
  name: [string, string];
  colorable?: boolean;
}[] = [
  { id: 'body', slot: 'body', from: 'body', name: ['바니 몸', 'Bunny body'] },
  { id: 'face', slot: 'face', from: 'face', name: ['바니 얼굴', 'Bunny face'] },
  {
    id: 'hair',
    slot: 'hair',
    from: 'hair',
    name: ['은발 단발과 토끼 귀', 'Silver bob, rabbit ears'],
    colorable: true,
  },
  {
    id: 'suit',
    slot: 'fullbody',
    from: 'fullbody',
    name: ['바니 수트', 'Bunny suit'],
    colorable: true,
  },
  { id: 'tights', slot: 'legwear', from: 'legwear', name: ['스타킹', 'Tights'] },
  { id: 'heels', slot: 'shoes', from: 'shoes', name: ['힐', 'Heels'] },
  { id: 'cuffs', slot: 'wrist', from: 'wrist', name: ['소매 커프스', 'Cuffs'] },
  { id: 'bowtie', slot: 'neck', from: 'neck', name: ['나비넥타이', 'Bow tie'] },
  { id: 'tail', slot: 'back', from: 'back', name: ['토끼 꼬리', 'Bunny tail'] },
];

/** The pack: pack.json, each part's 64×128 art and its 16×32 drawing. */
export function writePack(classicFor: (id: string, art: Img) => Img = (_, a) => classicOf4(a)) {
  const { sheets, hair, faces } = buildParts();
  const parts: unknown[] = [];
  const file = (name: string, img: Img) => {
    writePng(path.join(PACK_DIR, 'parts', name), quantize(img));
    return `parts/${name}`;
  };
  const art = (id: string, img: Img) => ({
    file: file(`${id}-64.png`, img),
    density: D,
    classic: file(`${id}-16.png`, classicFor(id, img)),
  });
  for (const p of PACK_PARTS) {
    const name = { ko: p.name[0], en: p.name[1] };
    if (p.from === 'face')
      parts.push({
        id: p.id,
        slot: p.slot,
        gender: 'f',
        name,
        expressions: Object.fromEntries(EXPRESSIONS.map((e) => [e, art(`${p.id}-${e}`, faces[e])])),
      });
    else if (p.from === 'hair')
      parts.push({
        id: p.id,
        slot: p.slot,
        gender: 'f',
        name,
        colorable: true,
        file: art(p.id, hair),
      });
    else
      parts.push({
        id: p.id,
        slot: p.slot,
        gender: 'f',
        name,
        ...(p.colorable && { colorable: true }),
        bodies: { curvy: art(p.id, sheets[p.from]) },
      });
  }
  const look = {
    v: 3,
    kind: 'person',
    gender: 'f',
    body: 'curvy',
    parts: {
      body: 'body',
      face: 'face',
      hair: 'hair',
      fullbody: 'suit',
      legwear: 'tights',
      shoes: 'heels',
      wrist: 'cuffs',
      neck: 'bowtie',
      back: 'tail',
    },
  };
  const pack = {
    id: 'hd-bunny',
    version: 1,
    title: { ko: '바니걸 64×128 견본', en: 'Bunny girl 64×128 sample' },
    parts,
    characters: [{ id: 'bunny', name: { ko: '바니', en: 'Bunny' } }],
    presets: [
      {
        id: 'bunny',
        character: 'bunny',
        outfit: 'bunny',
        name: { ko: '바니걸 (64×128)', en: 'Bunny girl (64×128)' },
        look,
      },
    ],
  };
  fs.writeFileSync(path.join(PACK_DIR, 'pack.json'), JSON.stringify(pack, null, 2) + '\n');
  return { sheets, hair, faces };
}

// ── through the registry: the pack's parts composited like the app does ───────────────────────

/** One sprite (#RRGGBB rows) as an image. */
const spriteImage = (sprite: string[][]): Img => {
  const out = blank(sprite[0].length, sprite.length);
  sprite.forEach((row, y) =>
    row.forEach(
      (c, x) =>
        c &&
        put(
          out,
          x,
          y,
          [1, 3, 5].map((k) => parseInt(c.slice(k, k + 2), 16)),
        ),
    ),
  );
  return out;
};

/** A composed sheet (#RRGGBB frames) as one image. */
export function sheetImage(sheet: {
  down: string[][][];
  up: string[][][];
  right: string[][][];
  density?: number;
}): Img {
  const d = sheet.density ?? 1;
  const out = blank(16 * d * FRAMES, 32 * d * 3);
  VIEWS.forEach((v, r) =>
    sheet[v].forEach((f, i) =>
      f.forEach((row, y) =>
        row.forEach((c, x) => {
          if (c)
            put(
              out,
              i * 16 * d + x,
              r * 32 * d + y,
              [1, 3, 5].map((k) => parseInt(c.slice(k, k + 2), 16)),
            );
        }),
      ),
    ),
  );
  return out;
}

/** The bunny as the app composes her, against the master; and her parts with another body and
 *  another outfit. Returns the pixels where the composite differs from the master. */
export async function writeComposites() {
  const { loadPack } = await import('../../server/src/cld/packs.js');
  const { composePerson } = await import('../../webview-ui/src/cld/characters/parts.js');
  const pack = loadPack(PACK_DIR, true);
  if ('error' in pack) throw new Error(pack.error);
  const look = pack.summary.presets[0].look;
  const compose = (l: object) => sheetImage(composePerson(l as never, pack.parts).sheet);
  const bunny = compose(look);
  const master = read(path.join(OUT, 'master-64x128.png'));
  let diff = 0;
  for (let i = 0; i < bunny.w * bunny.h; i++)
    if (
      bunny.data[i * 4 + 3] !== master.data[i * 4 + 3] ||
      (bunny.data[i * 4 + 3] &&
        [0, 1, 2].some((k) => Math.abs(bunny.data[i * 4 + k] - master.data[i * 4 + k]) > 8))
    )
      diff++;
  writePng(path.join(OUT, 'composite-bunny.png'), bunny);
  const p = (id: string) => `hd-bunny/${id}`;
  const parts = look.parts!;
  const variants: [string, object][] = [
    // her parts on the standard body: the head parts sit, the curvy suit is not drawn for it
    ['standard-body', { ...look, body: 'standard', parts: { ...parts, body: 'basic' } }],
    // her body and head in the built-in office clothes (drawn for the standard body)
    [
      'builtin-outfit',
      {
        v: 3,
        kind: 'person',
        gender: 'f',
        body: 'curvy',
        parts: {
          body: p('body'),
          face: p('face'),
          hair: p('hair'),
          top: 'top-1',
          bottom: 'bottom-0',
          shoes: 'shoes-0',
        },
      },
    ],
    // her hair and face on the built-in body in its own clothes
    [
      'head-on-basic',
      {
        v: 3,
        kind: 'person',
        gender: 'f',
        parts: {
          body: 'basic',
          face: p('face'),
          hair: p('hair'),
          top: 'top-1',
          bottom: 'bottom-0',
          shoes: 'shoes-0',
        },
      },
    ],
    // her suit recoloured, smiling
    ['red-suit-smile', { ...look, expr: 'smile', colors: { fullbody: RED_SUIT } }],
    ['wink', { ...look, expr: 'wink' }],
  ];
  const report: Record<string, unknown> = { masterDiffPixels: diff };
  for (const [name, l] of variants) {
    const r = composePerson(l as never, pack.parts);
    report[name] = {
      density: r.sheet.density ?? 1,
      missing: r.missing,
      unavailable: r.unavailable,
    };
    writePng(path.join(OUT, `composite-${name}.png`), sheetImage(r.sheet));
  }
  fs.writeFileSync(path.join(OUT, 'composites.json'), JSON.stringify(report, null, 2) + '\n');
  return report;
}

/** Step 3's pictures: the master, its 32×64 copy (halved and cleaned, as the app makes it), the
 *  hand-tuned 16×32 (from the parts' own drawings) and, for contrast, the master halved twice. */
export async function writeLods() {
  const { loadPack } = await import('../../server/src/cld/packs.js');
  const { compose, halveSheet } = await import('../../webview-ui/src/cld/characters/compose.js');
  const pack = loadPack(PACK_DIR, true);
  if ('error' in pack) throw new Error(pack.error);
  const c = compose(pack.summary.presets[0].look, { templates: [], parts: pack.parts });
  const [half, classic] = c.sheet.lods ?? [];
  const twice = halveSheet(halveSheet(c.sheet), false);
  const imgs = [c.sheet, half, classic, twice].map((s) => sheetImage(s as never));
  writePng(path.join(OUT, 'lod-32x64.png'), imgs[1]);
  writePng(path.join(OUT, 'lod-16x32.png'), imgs[2]);
  writePng(path.join(OUT, 'lod-16x32-halved-twice.png'), imgs[3]);
  // per view the standing and a typing frame, every copy at the same world size (×1, ×2, ×4, ×4)
  const cells = (img: Img, d: number, view: number, f: number) => {
    const o = blank(16 * d, 32 * d);
    over(o, img, -f * 16 * d, -view * 32 * d);
    return zoomed(o, 4 / d);
  };
  const rows = [0, 1, 2].flatMap((v) =>
    [1, 3].map((f) =>
      strip(
        [
          cells(imgs[0], 4, v, f),
          cells(imgs[1], 2, v, f),
          cells(imgs[2], 1, v, f),
          cells(imgs[3], 1, v, f),
        ],
        6,
      ),
    ),
  );
  writePng(path.join(OUT, 'lods-side-by-side.png'), zoomed(stack(rows, 4), 2));
  // the card's portrait (the 32×64 copy's crop), four times
  if (c.mugshot)
    writePng(path.join(OUT, 'portrait-card-x4.png'), zoomed(spriteImage(c.mugshot), 4));
  return {
    portrait: c.mugshot?.length ?? 0,
    lods: c.sheet.lods?.map((l) => (l as { density?: number }).density ?? 1),
  };
}

if (require.main === module && process.argv[2] !== 'debug') {
  writeMaster();
  writePack(handTuned);
  void writeComposites()
    .then((r) => console.log(JSON.stringify(r)))
    .then(writeLods)
    .then((r) => console.log(JSON.stringify(r)));
}
