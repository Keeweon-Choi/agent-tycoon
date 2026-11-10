/**
 * SHEET-IMPORT: a generated character sheet (figures on a flat #FF00FF background, no grid or
 * labels) -> its cells. Two formats, both 7 columns (standing, walk left foot, walk right foot,
 * typing A, typing B, reading A, reading B):
 *   iso  2 rows: three-quarter front (facing the lower right), three-quarter back (upper right)
 *   top  3 rows: front, back, right side
 * Pure over decoded RGBA; the original is never changed.
 *
 *   cutSheet  the background (magenta and the halo it bled into the figures' edges), the figures
 *             (connected pieces; a small piece near a figure is part of it, a stray speck far
 *             from all is dropped; a touching pair is split), grouped into rows of 7, or why not
 */
import type { Rgba } from './assetSnap.js';

export const FRAMES = 7;
export type SheetFormat = 'iso' | 'top';
export const FORMAT_OF_ROWS: Record<number, SheetFormat> = { 2: 'iso', 3: 'top' };

/** Background: this close to #FF00FF (the generator's flat magenta is noisy by up to ~50). */
const BG_DISTANCE = 64;
/** Halo: an edge pixel this close to magenta, or whose green sits this far under its red and
 *  blue (a figure's colour blended with magenta), is background too; up to HALO_RINGS deep. */
const HALO_DISTANCE = 110;
const HALO_TINT = 60;
const HALO_RINGS = 2;
/** Magenta enclosed by a figure (a gap between strands of hair, in shade): red and blue both
 *  over this and green this far under both. A purple eye or a pink rose is far from it. */
const POCKET_RB = 100;
const POCKET_TINT = 85;
/** A piece at least this share of the largest piece is a figure. */
const FIGURE_SHARE = 0.12;
/** A smaller piece whose box is this close to a figure's box (a share of the figures' median
 *  height: ~20 px on a 440 px figure) belongs to it (a strand of hair). */
const ATTACH_SHARE = 0.05;
/** A piece this many column widths wide is touching figures. */
const SPLIT_PITCH = 1.5;
/** A cut is looked for this share of a part's width around its border. */
const SPLIT_SLACK = 0.25;
/** Touching figures are eroded up to this many px to find their bodies, each at least this share
 *  of the whole. */
const MAX_ERODE = 12;
const CORE_SHARE = 0.1;
/** Figures whose centres are this share of the median height apart start a new row. */
const ROW_GAP = 0.5;
/** Under this share of background the sheet is not on magenta. */
const MIN_BG_SHARE = 0.2;

export const isHalo = (r: number, g: number, b: number) =>
  Math.hypot(r - 255, g, b - 255) < HALO_DISTANCE || Math.min(r, b) - g > HALO_TINT;

export interface Figure {
  /** Its pixels' label in `CutSheet.label`. */
  id: number;
  /** [x0, y0, x1, y1), source px. */
  box: number[];
}

export interface CutSheet {
  format: SheetFormat;
  /** Per pixel: the figure id (1-based) it belongs to, 0 = background or a dropped speck. */
  label: Int32Array;
  /** Per pixel: 1 = background (magenta or its halo). */
  bg: Uint8Array;
  /** rows × 7. */
  cells: Figure[][];
  /** Halo pixels taken as background, specks dropped (pieces, pixels), pairs split; pixels given
   *  back to the figure they are nearest (a neighbour's strand of hair or hem that a split or a
   *  box left in a cell), and the cell that gave most (row, column from 1). */
  stats: {
    halo: number;
    specks: number;
    speckPixels: number;
    split: number;
    bleed: { moved: number; worst: { row: number; col: number; px: number } | null };
  };
}

/** Why a sheet was refused: a daemon text code (core serverText) and its holes. */
export interface CutRefusal {
  code:
    'sheet_import_background' | 'sheet_import_rows' | 'sheet_import_missing' | 'sheet_import_extra';
  vars: Record<string, number>;
}

/** Background mask: magenta, then the halo rings around it. */
export function backgroundOf(img: Rgba): { bg: Uint8Array; halo: number } {
  const { width: W, height: H, data: d } = img;
  const bg = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) {
    const [r, g, b] = [d[i * 4], d[i * 4 + 1], d[i * 4 + 2]];
    if (
      d[i * 4 + 3] < 128 ||
      Math.hypot(r - 255, g, b - 255) < BG_DISTANCE ||
      (r > POCKET_RB && b > POCKET_RB && Math.min(r, b) - g > POCKET_TINT)
    )
      bg[i] = 1;
  }
  let halo = 0;
  for (let ring = 0; ring < HALO_RINGS; ring++) {
    const add: number[] = [];
    for (let i = 0; i < W * H; i++) {
      if (bg[i]) continue;
      const x = i % W;
      const touches = (x > 0 && bg[i - 1]) || (x < W - 1 && bg[i + 1]) || bg[i - W] || bg[i + W];
      if (touches && isHalo(d[i * 4], d[i * 4 + 1], d[i * 4 + 2])) add.push(i);
    }
    for (const i of add) bg[i] = 1;
    halo += add.length;
  }
  return { bg, halo };
}

/** 8-connected pieces of the foreground: a label per pixel and each piece's box and size. */
function pieces(bg: Uint8Array, W: number, H: number) {
  const label = new Int32Array(W * H);
  const out: { n: number; box: number[] }[] = [];
  const stack: number[] = [];
  for (let s = 0; s < W * H; s++) {
    if (bg[s] || label[s]) continue;
    const id = out.length + 1;
    label[s] = id;
    stack.push(s);
    let [n, x0, y0, x1, y1] = [0, W, H, 0, 0];
    while (stack.length) {
      const i = stack.pop()!;
      n++;
      const x = i % W;
      const y = (i / W) | 0;
      if (x < x0) x0 = x;
      if (x >= x1) x1 = x + 1;
      if (y < y0) y0 = y;
      if (y >= y1) y1 = y + 1;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
          const j = yy * W + xx;
          if (!bg[j] && !label[j]) {
            label[j] = id;
            stack.push(j);
          }
        }
    }
    out.push({ n, box: [x0, y0, x1, y1] });
  }
  return { label, pieces: out };
}

const gap = (a: number[], b: number[]) =>
  Math.max(0, a[0] - b[2], b[0] - a[2], a[1] - b[3], b[1] - a[3]);
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

/**
 * Figure `f` (`k` figures that touch) cut into `k` side by side: its mask is eroded until it
 * falls into `k` cores of some size (the thin strands where hair or a hand touches a neighbour
 * go first, bodies stay), and every pixel goes to the core that reaches it first through the
 * figure's own pixels (a hand to its arm, a strand of hair split where the two meet). When no
 * erosion separates them, each cut is the column with the fewest pixels near the even border.
 * Relabels `label`; returns the parts left to right.
 */
function splitFigure(
  label: Int32Array,
  W: number,
  f: Figure,
  k: number,
  newId: () => number,
  straight = false,
) {
  const [x0, y0, x1, y1] = f.box;
  const [bw, bh] = [x1 - x0, y1 - y0];
  const inside = new Uint8Array(bw * bh);
  let area = 0;
  for (let y = 0; y < bh; y++)
    for (let x = 0; x < bw; x++)
      if (label[(y0 + y) * W + x0 + x] === f.id) [inside[y * bw + x], area] = [1, area + 1];
  const cores = straight ? null : erodedCores(inside, bw, bh, k, area);
  const parts: Figure[] = Array.from({ length: k }, (_, i) => ({
    id: i ? newId() : f.id,
    box: [x1, y1, x0, y0],
  }));
  const own = new Int32Array(bw * bh); // part index + 1
  if (cores) {
    // regrow: breadth first from every core at once, through the figure's pixels
    let front: number[] = [];
    cores.forEach((core, p) => {
      for (const i of core) [own[i], front[front.length]] = [p + 1, i];
    });
    while (front.length) {
      const next: number[] = [];
      for (const i of front) {
        const x = i % bw;
        for (const j of [x > 0 ? i - 1 : -1, x < bw - 1 ? i + 1 : -1, i - bw, i + bw])
          if (j >= 0 && j < bw * bh && inside[j] && !own[j]) {
            own[j] = own[i];
            next.push(j);
          }
      }
      front = next;
    }
  } else {
    const part = bw / k;
    const cuts: number[] = [];
    for (let i = 1; i < k; i++) {
      let [best, least] = [Math.round(part * i), Infinity];
      for (let x = Math.round(part * (i - SPLIT_SLACK)); x <= part * (i + SPLIT_SLACK); x++) {
        let n = 0;
        for (let y = 0; y < bh; y++) if (inside[y * bw + x]) n++;
        if (n < least) [best, least] = [x, n];
      }
      cuts.push(best);
    }
    for (let i = 0; i < bw * bh; i++) {
      if (!inside[i]) continue;
      let p = 0;
      while (p < cuts.length && i % bw >= cuts[p]) p++;
      own[i] = p + 1;
    }
  }
  for (let y = 0; y < bh; y++)
    for (let x = 0; x < bw; x++) {
      const o = own[y * bw + x];
      if (!o) continue;
      const g = parts[o - 1];
      label[(y0 + y) * W + x0 + x] = g.id;
      const b = g.box;
      const [gx, gy] = [x0 + x, y0 + y];
      if (gx < b[0]) b[0] = gx;
      if (gy < b[1]) b[1] = gy;
      if (gx + 1 > b[2]) b[2] = gx + 1;
      if (gy + 1 > b[3]) b[3] = gy + 1;
    }
  return parts;
}

/** The `k` largest pieces (left to right, as pixel lists) of `mask` eroded the least that splits
 *  it into `k` pieces of at least CORE_SHARE of its area each, or null (up to MAX_ERODE px). */
function erodedCores(mask: Uint8Array, w: number, h: number, k: number, area: number) {
  let m = mask;
  for (let r = 1; r <= MAX_ERODE; r++) {
    const e = new Uint8Array(w * h);
    for (let y = 1; y < h - 1; y++)
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        e[i] = m[i] && m[i - 1] && m[i + 1] && m[i - w] && m[i + w] ? 1 : 0;
      }
    m = e;
    const seen = new Uint8Array(w * h);
    const big: number[][] = [];
    for (let s = 0; s < w * h; s++) {
      if (!m[s] || seen[s]) continue;
      const px = [s];
      seen[s] = 1;
      for (let q = 0; q < px.length; q++) {
        const i = px[q];
        const x = i % w;
        for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w])
          if (j >= 0 && j < w * h && m[j] && !seen[j]) {
            seen[j] = 1;
            px.push(j);
          }
      }
      if (px.length >= area * CORE_SHARE) big.push(px);
    }
    if (big.length >= k) {
      const cx = (px: number[]) => px.reduce((t, i) => t + (i % w), 0) / px.length;
      return big
        .sort((a, b) => b.length - a.length)
        .slice(0, k)
        .sort((a, b) => cx(a) - cx(b));
    }
    if (!big.length) return null;
  }
  return null;
}

/**
 * Each cell only its own figure: every figure's largest connected piece is its body; every other
 * piece of any figure (a strand cut off by a split, a strand of hair attached by its box) goes to
 * the body it is nearest (a multi-source search out to `reach` px from every body), or is dropped
 * when no body is that near. Boxes are recomputed. Returns the pixels moved per figure id.
 */
function untangle(label: Int32Array, W: number, H: number, figs: Figure[], reach: number) {
  const ids = new Set(figs.map((f) => f.id));
  const piece = new Int32Array(W * H);
  const pieces: { id: number; px: number[] }[] = [{ id: 0, px: [] }];
  const stack: number[] = [];
  for (let s = 0; s < W * H; s++) {
    if (!label[s] || piece[s]) continue;
    const id = label[s];
    const px: number[] = [];
    piece[s] = pieces.length;
    stack.push(s);
    while (stack.length) {
      const i = stack.pop()!;
      px.push(i);
      const x = i % W;
      for (let dy = -W; dy <= W; dy += W)
        for (let dx = -1; dx <= 1; dx++) {
          const j = i + dy + dx;
          if (j < 0 || j >= W * H || (dx === -1 && x === 0) || (dx === 1 && x === W - 1)) continue;
          if (label[j] === id && !piece[j]) {
            piece[j] = pieces.length;
            stack.push(j);
          }
        }
    }
    pieces.push({ id, px });
  }
  // each figure's body: its largest piece
  const body = new Map<number, number>();
  pieces.forEach((p, k) => {
    if (k && ids.has(p.id) && (!body.has(p.id) || p.px.length > pieces[body.get(p.id)!].px.length))
      body.set(p.id, k);
  });
  // the nearest body of every pixel within `reach`
  const near = new Int32Array(W * H);
  let front: number[] = [];
  for (const [id, k] of body)
    for (const i of pieces[k].px) [near[i], front[front.length]] = [id, i];
  for (let d = 0; d < reach && front.length; d++) {
    const next: number[] = [];
    for (const i of front) {
      const x = i % W;
      for (const j of [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, i - W, i + W])
        if (j >= 0 && j < W * H && !near[j]) {
          near[j] = near[i];
          next.push(j);
        }
    }
    front = next;
  }
  const moved = new Map<number, number>();
  pieces.forEach((p, k) => {
    if (!k || body.get(p.id) === k) return;
    const votes = new Map<number, number>();
    for (const i of p.px) votes.set(near[i], (votes.get(near[i]) ?? 0) + 1);
    let [to, most] = [0, 0];
    for (const [id, n] of votes) if (id && n > most) [to, most] = [id, n];
    if (to === p.id) return;
    moved.set(p.id, (moved.get(p.id) ?? 0) + p.px.length);
    for (const i of p.px) label[i] = to;
  });
  for (const f of figs) f.box = [W, H, 0, 0];
  const byId = new Map(figs.map((f) => [f.id, f]));
  for (let i = 0; i < W * H; i++) {
    const f = label[i] ? byId.get(label[i]) : undefined;
    if (!f) continue;
    const [x, y] = [i % W, (i / W) | 0];
    const b = f.box;
    if (x < b[0]) b[0] = x;
    if (y < b[1]) b[1] = y;
    if (x + 1 > b[2]) b[2] = x + 1;
    if (y + 1 > b[3]) b[3] = y + 1;
  }
  return moved;
}

/** The figures of a sheet in rows of 7, or why it is not a sheet of this kind. */
export function cutSheet(
  img: Rgba,
  /** `before`: the cut as it was before 10-26 03:10 (straight splits, no untangling), for the
   *  before/after picture. */
  opts: { before?: boolean } = {},
): CutSheet | CutRefusal {
  const { width: W, height: H } = img;
  const { bg, halo } = backgroundOf(img);
  let bgCount = 0;
  for (const v of bg) bgCount += v;
  if (bgCount < W * H * MIN_BG_SHARE)
    return {
      code: 'sheet_import_background',
      vars: { share: Math.round((bgCount / (W * H)) * 100) },
    };
  const { label, pieces: all } = pieces(bg, W, H);
  const largest = Math.max(0, ...all.map((p) => p.n));
  // piece id -> figure id (its own for a figure, its figure's for an attached piece, 0 = dropped)
  const owner = new Int32Array(all.length + 1);
  const figures: Figure[] = [];
  all.forEach((p, k) => {
    if (p.n >= largest * FIGURE_SHARE) {
      owner[k + 1] = k + 1;
      figures.push({ id: k + 1, box: [...p.box] });
    }
  });
  const attach = (median(figures.map((f) => f.box[3] - f.box[1])) ?? 0) * ATTACH_SHARE;
  let specks = 0;
  let speckPixels = 0;
  all.forEach((p, k) => {
    if (owner[k + 1]) return;
    let best: Figure | null = null;
    for (const f of figures)
      if (gap(p.box, f.box) <= attach && (!best || gap(p.box, f.box) < gap(p.box, best.box)))
        best = f;
    if (!best) {
      specks++;
      speckPixels += p.n;
      return;
    }
    owner[k + 1] = best.id;
    const b = best.box;
    [b[0], b[1], b[2], b[3]] = [
      Math.min(b[0], p.box[0]),
      Math.min(b[1], p.box[1]),
      Math.max(b[2], p.box[2]),
      Math.max(b[3], p.box[3]),
    ];
  });
  for (let i = 0; i < label.length; i++) label[i] = owner[label[i]];
  // rows by the figures' vertical centres
  const cy = (f: Figure) => (f.box[1] + f.box[3]) / 2;
  const height = median(figures.map((f) => f.box[3] - f.box[1])) ?? 0;
  const sorted = [...figures].sort((a, b) => cy(a) - cy(b));
  const rows: Figure[][] = [];
  for (const f of sorted) {
    const row = rows[rows.length - 1];
    if (row && cy(f) - cy(row[row.length - 1]) <= height * ROW_GAP) row.push(f);
    else rows.push([f]);
  }
  for (const row of rows) row.sort((a, b) => a.box[0] - b.box[0]);
  const found = () => rows.reduce((n, r) => n + r.length, 0);
  if (!FORMAT_OF_ROWS[rows.length])
    return { code: 'sheet_import_rows', vars: { found: found(), rows: rows.length } };
  let split = 0;
  let nextId = all.length + 1;
  // touching figures (hair over a neighbour): a piece far wider than a column is cut into as many
  // figures as columns it spans, each cut where the piece is thinnest near the column border
  const pitch = W / FRAMES;
  for (const row of rows)
    for (;;) {
      if (row.length >= FRAMES) break;
      const widest = row.reduce((a, b) => (b.box[2] - b.box[0] > a.box[2] - a.box[0] ? b : a));
      const w = widest.box[2] - widest.box[0];
      if (w < pitch * SPLIT_PITCH) break;
      const k = Math.min(FRAMES - row.length + 1, Math.max(2, Math.round(w / pitch)));
      row.splice(
        row.indexOf(widest),
        1,
        ...splitFigure(label, W, widest, k, () => nextId++, !!opts.before),
      );
      split++;
    }
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    if (row.length > FRAMES)
      return {
        code: 'sheet_import_extra',
        vars: { found: found(), row: r + 1, count: row.length },
      };
    if (row.length < FRAMES) {
      // the columns are even across the sheet: the first one no figure stands in is missing
      const taken = new Set(
        row.map((f) => Math.min(FRAMES - 1, Math.floor(((f.box[0] + f.box[2]) / 2 / W) * FRAMES))),
      );
      const col = Array.from({ length: FRAMES }, (_, c) => c).find((c) => !taken.has(c)) ?? 0;
      return {
        code: 'sheet_import_missing',
        vars: { found: found(), row: r + 1, col: col + 1, count: row.length },
      };
    }
  }
  const moved = opts.before
    ? new Map<number, number>()
    : untangle(label, W, H, rows.flat(), Math.ceil(attach));
  let worst: CutSheet['stats']['bleed']['worst'] = null;
  rows.forEach((row, r) =>
    row.forEach((f, c) => {
      const px = moved.get(f.id) ?? 0;
      if (px && (!worst || px > worst.px)) worst = { row: r + 1, col: c + 1, px };
    }),
  );
  const bleed = { moved: [...moved.values()].reduce((a, b) => a + b, 0), worst };
  return {
    format: FORMAT_OF_ROWS[rows.length],
    label,
    bg,
    cells: rows,
    stats: { halo, specks, speckPixels, split, bleed },
  };
}

// ── step 2: one frame size for every imported sheet ──────────────────────────

/** Sprite px per world px (owner 10-26 02:04: keep almost all of the source's detail). */
export const IMPORT_DENSITY = 12;
/** The world frame of an imported character (owner 10-26 03:10: HD characters may be bigger):
 *  24×44 world px (288×528), so the standing figure is 1.3 times a classic one's 29.5 px (38.4:
 *  the owner's ~440-466 px figures at about 1:1) with room for a hat over it, and the widest
 *  poses (seated legs, long hair and hems, ~280 source px) fit beside it without shrinking. */
export const IMPORT_WORLD_W = 24;
export const IMPORT_WORLD_H = 44;
export const IMPORT_FRAME_W = IMPORT_WORLD_W * IMPORT_DENSITY;
export const IMPORT_FRAME_H = IMPORT_WORLD_H * IMPORT_DENSITY;
/** The feet end one world px over the frame's bottom, as char_N's (row 30 of 32). */
const FLOOR_BOTTOM = (IMPORT_WORLD_H - 1) * IMPORT_DENSITY;
/** The tallest standing figure stands 1.3 classic figures tall. */
const FIGURE_ROWS = 1.3 * 29.5 * IMPORT_DENSITY;
const FRAME_MARGIN = 2;
/** The head: this share of the standing height from a figure's top; the feet: this share up
 *  from its bottom. */
const HEAD_BAND = 0.12;
const FOOT_BAND = 0.05;
/** Within this many px of the background, the magenta a colour still carries is taken out. */
const SPILL_DEPTH = 3;
/** The generator's magenta as it comes (noisy around this), its red/blue over its green, and the
 *  least opacity an unmixed edge pixel keeps (under it, it was background). */
const SHEET_MAGENTA = [245, 10, 242];
const MAGENTA_SPAN = 232;
const MIN_UNMIXED = 0.1;
/** Output pixels with less alpha than this are left empty (no faint fringe). */
const ALPHA_FLOOR = 8;
const WALK = [0, 1, 2];
const SEATED = [3, 4, 5, 6];

export interface ImportReport {
  format: SheetFormat;
  density: number;
  /** Output px per source px (one for the whole sheet). */
  scale: number;
  /** The largest move from one frame to the next of the head, px: walk frames (a step bobs a
   *  little) and seated frames (held still). */
  headJitter: { walk: { x: number; y: number }; seated: { x: number; y: number } };
  /** Per row: how different the two walk frames' legs are (0 = the same, 1 = nothing alike);
   *  under WALK_ALIKE the legs would not alternate (`walkAlike` lists those rows, from 1). */
  walkLegs: number[];
  walkAlike: number[];
  /** The largest move of the lowest row between walk frames (the feet on the floor), px. */
  footJitter: number;
  /** The frame that made the scale smaller than the standing height asks (row, column from 1),
   *  and by how much (a share: 1 = not at all); every figure stays whole inside its frame. */
  fit: { row: number; col: number; shrink: number } | null;
  /** Output pixels still magenta-like, and those of them on the silhouette's edge (halo). */
  magenta: number;
  halo: number;
  /** Pixels given back from a cell to the figure they are nearest (a neighbour's strand). */
  bleed: CutSheet['stats']['bleed'];
  /** What the cut took out: halo pixels, specks; touching pairs split. */
  haloRemoved: number;
  specks: number;
  split: number;
  ms: number;
}

/** Where a figure's pixels came from: a frame's output px (X, Y) is source ((X - tx) / s,
 *  (Y - ty) / s). For the window's frame boxes. */
export interface Placement {
  box: number[];
  tx: number;
  ty: number;
}

interface Measured {
  f: Figure;
  headX: number;
  footX: number;
}

/** The centroid x of figure `f`'s pixels in rows [y0, y1). */
function centroidX(label: Int32Array, W: number, f: Figure, y0: number, y1: number): number {
  let [n, sx] = [0, 0];
  for (let y = Math.max(f.box[1], Math.floor(y0)); y < Math.min(f.box[3], y1); y++)
    for (let x = f.box[0]; x < f.box[2]; x++)
      if (label[y * W + x] === f.id) [n, sx] = [n + 1, sx + x + 0.5];
  return n ? sx / n : (f.box[0] + f.box[2]) / 2;
}

/** Box-filter weights along one axis: output index o covers source [(o - t) / s, (o + 1 - t) / s). */
function weights(o0: number, o1: number, t: number, s: number, i0: number, i1: number) {
  const out: { src: number[]; w: number[] }[] = [];
  for (let o = o0; o < o1; o++) {
    const a = (o - t) / s;
    const b = (o + 1 - t) / s;
    const src: number[] = [];
    const w: number[] = [];
    for (let i = Math.max(i0, Math.floor(a)); i < Math.min(i1, Math.ceil(b)); i++) {
      const cover = Math.min(b, i + 1) - Math.max(a, i);
      if (cover > 0) [src[src.length], w[w.length]] = [i, cover * s];
    }
    out.push({ src, w });
  }
  return out;
}

/** Figure `f` resampled into a frame (area average, premultiplied alpha; `nearest`: the source
 *  pixel under each output pixel's centre, for comparison), translated by (tx, ty). */
export function resampleFigure(
  img: Rgba,
  label: Int32Array,
  f: Figure,
  s: number,
  tx: number,
  ty: number,
  nearest = false,
): Uint8Array {
  const [W, FW, FH] = [img.width, IMPORT_FRAME_W, IMPORT_FRAME_H];
  const out = new Uint8Array(FW * FH * 4);
  const [x0, y0, x1, y1] = f.box;
  const ox0 = Math.max(0, Math.floor(x0 * s + tx));
  const ox1 = Math.min(FW, Math.ceil(x1 * s + tx));
  const oy0 = Math.max(0, Math.floor(y0 * s + ty));
  const oy1 = Math.min(FH, Math.ceil(y1 * s + ty));
  const px = (x: number, y: number) => {
    const i = y * W + x;
    return label[i] === f.id ? i * 4 : -1;
  };
  if (nearest) {
    for (let oy = oy0; oy < oy1; oy++)
      for (let ox = ox0; ox < ox1; ox++) {
        const x = Math.floor((ox + 0.5 - tx) / s);
        const y = Math.floor((oy + 0.5 - ty) / s);
        if (x < x0 || y < y0 || x >= x1 || y >= y1) continue;
        const p = px(x, y);
        if (p >= 0) out.set([...img.data.subarray(p, p + 3), 255], (oy * FW + ox) * 4);
      }
    return out;
  }
  const wx = weights(ox0, ox1, tx, s, x0, x1);
  const wy = weights(oy0, oy1, ty, s, y0, y1);
  const cw = ox1 - ox0;
  // horizontal pass over the figure's rows: premultiplied r, g, b and alpha
  const tmp = new Float32Array((y1 - y0) * cw * 4);
  for (let y = y0; y < y1; y++)
    for (let c = 0; c < cw; c++) {
      const { src, w } = wx[c];
      let [r, g, b, a] = [0, 0, 0, 0];
      for (let k = 0; k < src.length; k++) {
        const p = px(src[k], y);
        if (p < 0) continue;
        const al = (img.data[p + 3] / 255) * w[k];
        r += img.data[p] * al;
        g += img.data[p + 1] * al;
        b += img.data[p + 2] * al;
        a += al;
      }
      tmp.set([r, g, b, a], ((y - y0) * cw + c) * 4);
    }
  for (let ry = 0; ry < oy1 - oy0; ry++) {
    const { src, w } = wy[ry];
    for (let c = 0; c < cw; c++) {
      let [r, g, b, a] = [0, 0, 0, 0];
      for (let k = 0; k < src.length; k++) {
        const q = ((src[k] - y0) * cw + c) * 4;
        r += tmp[q] * w[k];
        g += tmp[q + 1] * w[k];
        b += tmp[q + 2] * w[k];
        a += tmp[q + 3] * w[k];
      }
      const alpha = Math.round(Math.min(1, a) * 255);
      if (alpha < ALPHA_FLOOR) continue;
      out.set(
        [Math.round(r / a), Math.round(g / a), Math.round(b / a), alpha],
        ((oy0 + ry) * FW + ox0 + c) * 4,
      );
    }
  }
  return out;
}

/** A copy of the image whose pixels near the background are unmixed from the magenta they carry
 *  (red and blue both over green: that excess is the background showing through), so no pink
 *  fringe lines the hair and a see-through ruffle keeps its own colour, partly transparent. Pixels
 *  farther in (an eye, a lilac ribbon) keep their colour. The original is not changed. */
export function despill(img: Rgba, bg: Uint8Array): Rgba {
  const { width: W, height: H } = img;
  const data = new Uint8Array(img.data);
  const depth = new Uint8Array(W * H);
  let front: number[] = [];
  for (let i = 0; i < W * H; i++) if (bg[i]) front.push(i);
  for (let d = 1; d <= SPILL_DEPTH; d++) {
    const next: number[] = [];
    for (const i of front) {
      const x = i % W;
      for (const j of [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, i - W, i + W])
        if (j >= 0 && j < W * H && !bg[j] && !depth[j]) {
          depth[j] = d;
          next.push(j);
        }
    }
    front = next;
  }
  for (let i = 0; i < W * H; i++) {
    if (!depth[i]) continue;
    const [r, g, b] = [data[i * 4], data[i * 4 + 1], data[i * 4 + 2]];
    // unmix: c = a·F + (1 - a)·M with F free of magenta (its red and blue not over its green)
    const spill = Math.min(r, b) - g;
    if (spill <= 0) continue;
    const a = 1 - spill / MAGENTA_SPAN;
    if (a < MIN_UNMIXED) {
      data[i * 4 + 3] = 0;
      continue;
    }
    const unmix = (c: number, m: number) =>
      Math.max(0, Math.min(255, Math.round((c - (1 - a) * m) / a)));
    data.set(
      [unmix(r, SHEET_MAGENTA[0]), unmix(g, SHEET_MAGENTA[1]), unmix(b, SHEET_MAGENTA[2])],
      i * 4,
    );
    data[i * 4 + 3] = Math.round(data[i * 4 + 3] * a);
  }
  return { width: W, height: H, data };
}

/** Legs: the frame's rows from this share of its height down. Two walk frames whose legs differ
 *  in less than this share of their pixels have the same foot forward. */
const LEGS_FROM = 0.55;
const WALK_ALIKE = 0.3;
const ALIKE_CELL = 8;
const ALIKE_SHIFT = 3;

/** How different the legs of walk frames 2 and 3 (columns 1, 2) of row `r` are: their
 *  silhouettes in cells of ALIKE_CELL px (a cell is on when half its pixels are opaque), at the
 *  best horizontal shift of up to ALIKE_SHIFT cells, as the share of cells on in one only. The
 *  same foot forward differs in a few cells at the edges; the other foot forward in the legs. */
export function legsDiff(data: Uint8Array, width: number, r: number, fa = 1, fb = 2): number {
  const [FW, FH] = [IMPORT_FRAME_W, IMPORT_FRAME_H];
  const y0 = Math.round(FH * LEGS_FROM);
  const [cols, rows] = [FW / ALIKE_CELL, Math.floor((FH - y0) / ALIKE_CELL)];
  const grid = (f: number) => {
    const g = new Uint8Array(cols * rows);
    for (let cy = 0; cy < rows; cy++)
      for (let cx = 0; cx < cols; cx++) {
        let n = 0;
        for (let y = 0; y < ALIKE_CELL; y++)
          for (let x = 0; x < ALIKE_CELL; x++)
            if (
              data[
                ((r * FH + y0 + cy * ALIKE_CELL + y) * width + f * FW + cx * ALIKE_CELL + x) * 4 + 3
              ] >= 128
            )
              n++;
        g[cy * cols + cx] = n * 2 >= ALIKE_CELL * ALIKE_CELL ? 1 : 0;
      }
    return g;
  };
  const [a, b] = [grid(fa), grid(fb)];
  let best = 1;
  for (let shift = -ALIKE_SHIFT; shift <= ALIKE_SHIFT; shift++) {
    let [either, one] = [0, 0];
    for (let cy = 0; cy < rows; cy++)
      for (let cx = 0; cx < cols; cx++) {
        const p = a[cy * cols + cx];
        const qx = cx + shift;
        const q = qx >= 0 && qx < cols ? b[cy * cols + qx] : 0;
        if (p || q) either++;
        if (p !== q) one++;
      }
    if (either) best = Math.min(best, one / either);
  }
  return Math.round(best * 100) / 100;
}

/** Opaque extent and head of a converted frame (alpha >= 128): for the jitter report. */
function frameMarks(data: Uint8Array, band: number) {
  const [FW, FH] = [IMPORT_FRAME_W, IMPORT_FRAME_H];
  const on = (x: number, y: number) => data[(y * FW + x) * 4 + 3] >= 128;
  let [top, bottom] = [-1, -1];
  for (let y = 0; y < FH; y++)
    for (let x = 0; x < FW; x++)
      if (on(x, y)) {
        if (top < 0) top = y;
        bottom = y;
        break;
      }
  let [n, sx] = [0, 0];
  for (let y = Math.max(0, top); y < Math.min(FH, top + band); y++)
    for (let x = 0; x < FW; x++) if (on(x, y)) [n, sx] = [n + 1, sx + x];
  return { top, bottom, headX: n ? sx / n : 0 };
}

/**
 * The cut sheet as frames of 192×384 (rows × 7, the source's row order), one scale for the whole
 * sheet: the tallest standing figure FIGURE_ROWS tall, smaller when a frame would not fit. Walk
 * frames: the standing feet on the frame's foot anchor (bottom centre), the walk frames' heads
 * where the standing head is, every walk frame's feet on the floor row. Seated frames: their
 * heads held at one place, centred as a group, the lowest feet on the floor row.
 */
export function convertSheet(
  img: Rgba,
  cut: CutSheet,
  opts: { nearest?: boolean } = {},
): {
  width: number;
  height: number;
  data: Uint8Array;
  places: Placement[][];
  report: ImportReport;
} {
  const t0 = performance.now();
  const W = img.width;
  const clean = despill(img, cut.bg);
  const rows = cut.cells.length;
  const [FW, FH] = [IMPORT_FRAME_W, IMPORT_FRAME_H];
  const AX = FW / 2;
  const standH = Math.max(...cut.cells.map((r) => r[0].box[3] - r[0].box[1]));
  const head = standH * HEAD_BAND;
  const foot = standH * FOOT_BAND;
  const measured: Measured[][] = cut.cells.map((row) =>
    row.map((f) => ({
      f,
      headX: centroidX(cut.label, W, f, f.box[1], f.box[1] + head),
      footX: centroidX(cut.label, W, f, f.box[3] - foot, f.box[3]),
    })),
  );
  // per frame its source anchor (ax, ay) and where it goes in the frame (AX + dx, AY), as a
  // function of the scale (the seated group's centring depends on it)
  const anchors = (s: number) =>
    measured.map((row) => {
      const stand = row[0];
      const lean = stand.headX - stand.footX;
      const walk = WALK.map((c) => ({ ax: row[c].headX - lean, ay: row[c].f.box[3], dx: 0 }));
      const tall = Math.max(...SEATED.map((c) => row[c].f.box[3] - row[c].f.box[1]));
      const seated = SEATED.map((c) => ({ ax: row[c].headX, ay: row[c].f.box[1] + tall, dx: 0 }));
      // the seated group's union, centred
      const left = Math.min(...SEATED.map((c, i) => row[c].f.box[0] - seated[i].ax));
      const right = Math.max(...SEATED.map((c, i) => row[c].f.box[2] - seated[i].ax));
      for (const a of seated) a.dx = -((left + right) / 2) * s;
      return [...walk, ...seated];
    });
  // the scale: the standing height, then every frame inside the frame (never clipped: a figure
  // too wide for it shrinks the sheet, and the report says which)
  const want = FIGURE_ROWS / standH;
  let s = want;
  let fit = null as ImportReport['fit'];
  for (let pass = 0; pass < 3; pass++)
    anchors(s).forEach((row, r) =>
      row.forEach((a, c) => {
        const [x0, y0, x1] = cut.cells[r][c].box;
        const X = AX + a.dx;
        const limits = [
          a.ax > x0 ? (X - FRAME_MARGIN) / (a.ax - x0) : Infinity,
          x1 > a.ax ? (FW - FRAME_MARGIN - X) / (x1 - a.ax) : Infinity,
          a.ay > y0 ? (FLOOR_BOTTOM - FRAME_MARGIN) / (a.ay - y0) : Infinity,
        ];
        const least = Math.min(...limits);
        if (least < s) [s, fit] = [least, { row: r + 1, col: c + 1, shrink: 0 }];
      }),
    );
  if (fit) fit.shrink = Math.round((s / want) * 1000) / 1000;
  const width = FW * FRAMES;
  const height = FH * rows;
  const data = new Uint8Array(width * height * 4);
  const places: Placement[][] = [];
  const marks: ReturnType<typeof frameMarks>[][] = [];
  anchors(s).forEach((row, r) => {
    places.push([]);
    marks.push([]);
    row.forEach((a, c) => {
      const f = cut.cells[r][c];
      const tx = Math.round(AX + a.dx - a.ax * s);
      // the feet's lower edge within half a pixel under the floor row: that row is drawn, the next is not
      const ty = Math.ceil(FLOOR_BOTTOM - 0.5 - a.ay * s);
      const frame = resampleFigure(clean, cut.label, f, s, tx, ty, opts.nearest);
      places[r].push({ box: [...f.box], tx, ty });
      marks[r].push(frameMarks(frame, head * s));
      for (let y = 0; y < FH; y++)
        data.set(frame.subarray(y * FW * 4, (y + 1) * FW * 4), ((r * FH + y) * width + c * FW) * 4);
    });
  });
  const headJitter = { walk: { x: 0, y: 0 }, seated: { x: 0, y: 0 } };
  let footJitter = 0;
  for (const m of marks)
    for (const [group, j] of [
      [WALK, headJitter.walk],
      [SEATED, headJitter.seated],
    ] as const)
      for (let k = 1; k < group.length; k++) {
        const [p, q] = [m[group[k - 1]], m[group[k]]];
        j.x = Math.max(j.x, Math.round(Math.abs(p.headX - q.headX) * 10) / 10);
        j.y = Math.max(j.y, Math.abs(p.top - q.top));
        if (group === WALK) footJitter = Math.max(footJitter, Math.abs(p.bottom - q.bottom));
      }
  const walkLegs = cut.cells.map((_, r) => legsDiff(data, width, r));
  let [magenta, halo] = [0, 0];
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      if (!data[o + 3] || !isHalo(data[o], data[o + 1], data[o + 2])) continue;
      magenta++;
      const clear = (xx: number, yy: number) =>
        xx < 0 || yy < 0 || xx >= width || yy >= height || !data[(yy * width + xx) * 4 + 3];
      if (
        data[o + 3] < 255 ||
        clear(x - 1, y) ||
        clear(x + 1, y) ||
        clear(x, y - 1) ||
        clear(x, y + 1)
      )
        halo++;
    }
  return {
    width,
    height,
    data,
    places,
    report: {
      format: cut.format,
      density: IMPORT_DENSITY,
      scale: Math.round(s * 1000) / 1000,
      headJitter,
      walkLegs,
      walkAlike: walkLegs.flatMap((d, r) => (d < WALK_ALIKE ? [r + 1] : [])),
      footJitter,
      fit,
      magenta,
      halo,
      bleed: cut.stats.bleed,
      haloRemoved: cut.stats.halo,
      specks: cut.stats.specks,
      split: cut.stats.split,
      ms: Math.round(performance.now() - t0),
    },
  };
}
