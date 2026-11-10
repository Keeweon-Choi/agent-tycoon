/**
 * building-a-1104 (owner 11-04 17:51, 19:47): the building's outside. Every storey has the same
 * plate (cols x depth tiles) and stands one ISO_STOREY_H above the one below. A storey below the
 * floor in focus is closed: its two front faces (the slab band, then the wall with its glass
 * bays) and its top. The floor in focus wears its slab band in the accent. The storeys above it
 * are lifted off: only their outline is drawn (drawOutlines), each labelled with its floor.
 *
 * The faces are drawn one iso px column at a time in the caller's transform (iso px), so a cache
 * scaled nearest keeps hard pixels, like the neighbours' boxes (gfx/bg/paint.ts).
 */
import {
  ISO_BAY_PX,
  ISO_FACADE,
  ISO_GLASS_BAND,
  ISO_HALF_H,
  ISO_HALF_W,
  ISO_LOBBY_GLASS_BAND,
  ISO_MULLION_PX,
  ISO_NIGHT_LIT,
  ISO_OUTLINE,
  ISO_OUTLINE_LABEL_INSET,
  ISO_OUTLINE_LABEL_MIN_PX,
  ISO_OUTLINE_LABEL_PX,
  ISO_OUTLINE_LINE_PX,
  ISO_OUTLINE_OVER_ALPHA,
  ISO_OUTLINE_W,
  ISO_ROOF_CAP_H,
  ISO_ROOF_H,
  ISO_ROOF_INSET,
  ISO_SHINE,
  ISO_SLAB_H,
  ISO_WALL_H,
  PIXEL_FONT_FAMILY,
} from '../../constants.js';
import { hash } from '../gfx/bg/layout.js';
import type { Pt } from './projection.js';

type Ctx = CanvasRenderingContext2D;
type Palette = (typeof ISO_FACADE)['day' | 'night'];

/** The plate's corners at `lift` (iso px): back, right, front, left. */
export function plateCorners(cols: number, depth: number, lift: number) {
  const at = (c: number, r: number): Pt => ({
    x: (c - r) * ISO_HALF_W,
    y: (c + r) * ISO_HALF_H - lift,
  });
  return { B: at(0, 0), R: at(cols, 0), F: at(cols, depth), L: at(0, depth) };
}

/** The plate's back and front edges at iso x (x between its left and right corners). */
export function plateEdges(cols: number, depth: number, lift: number, x: number): [number, number] {
  const { B, F, L } = plateCorners(cols, depth, lift);
  const back = x < B.x ? L.y - (x - L.x) / 2 : B.y + (x - B.x) / 2;
  const front = x < F.x ? L.y + (x - L.x) / 2 : F.y - (x - F.x) / 2;
  return [back, front];
}

/** Whether iso px (x, y) is on the storey at `lift` as drawn closed: between its top (the plate's
 *  back edge a wall up) and the bottom of its slab under the front edge. */
export function inStorey(cols: number, depth: number, lift: number, x: number, y: number): boolean {
  const { L, R } = plateCorners(cols, depth, lift);
  if (x < L.x || x >= R.x) return false;
  const [back, front] = plateEdges(cols, depth, lift, x);
  return y >= back - ISO_WALL_H && y < front + ISO_SLAB_H;
}

/** Whether iso px (x, y) is on the front faces of the storey at `lift` (its wall and slab band):
 *  what of a storey shows when the storey above it is there. */
export function onFaces(cols: number, depth: number, lift: number, x: number, y: number): boolean {
  const { L, R } = plateCorners(cols, depth, lift);
  if (x < L.x || x >= R.x) return false;
  const front = plateEdges(cols, depth, lift, x)[1];
  return y >= front - ISO_WALL_H && y < front + ISO_SLAB_H;
}

/** Whether iso px (x, y) is on the roof over the storey at `lift` (the top one). */
export function onRoof(cols: number, depth: number, lift: number, x: number, y: number): boolean {
  const { L, R } = plateCorners(cols, depth, lift);
  if (x < L.x || x >= R.x) return false;
  const [back, front] = plateEdges(cols, depth, lift, x);
  return y >= back - ISO_WALL_H - ISO_ROOF_H && y < front - ISO_WALL_H;
}

/** One face, a column at a time: `p0` its left end on the plate's edge, running to `p1`. */
function faceColumns(p0: Pt, p1: Pt, fn: (x: number, line: number, u: number) => void): void {
  const down = p1.y > p0.y;
  for (let u = 0; u < p1.x - p0.x; u++)
    fn(p0.x + u, Math.round(p0.y + ((down ? 1 : -1) * (u + 0.5)) / 2), u);
}

/**
 * A closed storey at `lift` (iso px): both front faces, glass bays (the lobby's taller, with a
 * transom), the top. `roof`: the top storey's parapet and deck. `focus`: its slab in the accent.
 */
export function drawClosedStorey(
  c: Ctx,
  cols: number,
  depth: number,
  lift: number,
  o: { lobby: boolean; roof: boolean; focus: boolean; night: boolean; seed: number },
): void {
  const K: Palette = o.night ? ISO_FACADE.night : ISO_FACADE.day;
  const { L, F, R } = plateCorners(cols, depth, lift);
  const cap = o.roof ? ISO_ROOF_H : 0;
  const band = o.lobby ? ISO_LOBBY_GLASS_BAND : ISO_GLASS_BAND;
  const face = (p0: Pt, p1: Pt, left: boolean) =>
    faceColumns(p0, p1, (x, line, u) => {
      const top = line - ISO_WALL_H - cap;
      c.fillStyle = o.focus ? K.accent : left ? K.trimL : K.trimR;
      c.fillRect(x, line, 1, ISO_SLAB_H);
      c.fillStyle = left ? K.wallL : K.wallR;
      c.fillRect(x, top, 1, ISO_WALL_H + cap);
      if (cap) {
        c.fillStyle = K.cap;
        c.fillRect(x, top, 1, ISO_ROOF_CAP_H);
      }
      const k = u % ISO_BAY_PX;
      if (k < ISO_MULLION_PX) return;
      const bay = Math.floor(u / ISO_BAY_PX);
      const lit = o.night && hash(bay, o.seed, left ? 1 : 2) < ISO_NIGHT_LIT;
      const g0 = line - band.to;
      for (let y = g0; y < line - band.from; y++) {
        const shine = (k + (y - g0)) % ISO_SHINE.period < ISO_SHINE.width;
        c.fillStyle = lit ? K.lit : shine ? K.shine : left ? K.glassL : K.glassR;
        c.fillRect(x, y, 1, 1);
      }
      if (o.lobby) {
        c.fillStyle = K.mull;
        c.fillRect(x, line - ISO_LOBBY_GLASS_BAND.transom, 1, ISO_MULLION_PX);
      }
    });
  face(L, F, true);
  face(F, R, false);
  const H = ISO_WALL_H + cap;
  for (let x = L.x; x < R.x; x++) {
    const [b, f] = plateEdges(cols, depth, lift, x + 0.5);
    c.fillStyle = o.roof ? K.cap : K.roof;
    c.fillRect(x, Math.round(b) - H, 1, Math.round(f - b));
  }
  if (!o.roof) return;
  // The deck, a little lower inside the parapet.
  const inner = plateCorners(cols - 2 * ISO_ROOF_INSET, depth - 2 * ISO_ROOF_INSET, lift);
  const shift = ISO_ROOF_INSET * 2 * ISO_HALF_H; // the inner plate's back corner, moved forward
  for (let x = inner.L.x; x < inner.R.x; x++) {
    const [b, f] = plateEdges(cols - 2 * ISO_ROOF_INSET, depth - 2 * ISO_ROOF_INSET, lift, x + 0.5);
    const y = Math.round(b) + shift - H;
    c.fillStyle = K.roofIn;
    c.fillRect(x, y + ISO_ROOF_CAP_H, 1, ISO_ROOF_CAP_H);
    c.fillStyle = K.roof;
    c.fillRect(x, y + 2 * ISO_ROOF_CAP_H, 1, Math.max(0, Math.round(f - b) - 2 * ISO_ROOF_CAP_H));
  }
}

/** The floor in focus: its slab band in the accent, over its slab pieces (iso px transform). */
export function drawFocusBand(
  c: Ctx,
  cols: number,
  depth: number,
  lift: number,
  night: boolean,
): void {
  const { L, F, R } = plateCorners(cols, depth, lift);
  c.fillStyle = (night ? ISO_FACADE.night : ISO_FACADE.day).accent;
  const col = (x: number, line: number) => c.fillRect(x, line, 1, ISO_SLAB_H);
  faceColumns(L, F, col);
  faceColumns(F, R, col);
}

/**
 * The lifted-off storeys' outline, in device px (`o` the device px of iso (0, 0), `s` device px per
 * iso px, `dpr` device px per CSS px): per storey its slab as a faint band along the front with
 * its floor line, the two outer corner posts, and on the top one the roof's edge all round; then
 * each storey's label by its front corner. Over the floor in focus (at `focusLift`) the lines are
 * fainter, so they never hide who works there.
 */
export function drawOutlines(
  c: Ctx,
  o: Pt,
  s: number,
  dpr: number,
  cols: number,
  depth: number,
  focusLift: number,
  storeys: ReadonlyArray<{ lift: number; top: boolean; label: string }>,
  night: boolean,
): void {
  if (!storeys.length) return;
  const K = night ? ISO_OUTLINE.night : ISO_OUTLINE.day;
  const X = (p: Pt) => Math.round(o.x + p.x * s) + 0.5;
  const Y = (p: Pt, up = 0) => Math.round(o.y + (p.y - up) * s) + 0.5;
  const line = Math.max(Math.round(ISO_OUTLINE_LINE_PX * dpr), Math.round(ISO_OUTLINE_W * s));
  const core = Math.max(Math.round(dpr), Math.round(line / 3));
  const bands = () => {
    c.beginPath();
    for (const st of storeys) {
      const { L, F, R } = plateCorners(cols, depth, st.lift);
      c.moveTo(X(L), Y(L));
      c.lineTo(X(F), Y(F));
      c.lineTo(X(R), Y(R));
      c.lineTo(X(R), Y(R, -ISO_SLAB_H));
      c.lineTo(X(F), Y(F, -ISO_SLAB_H));
      c.lineTo(X(L), Y(L, -ISO_SLAB_H));
      c.closePath();
    }
  };
  const lines = () => {
    c.beginPath();
    for (const st of storeys) {
      const { B, L, F, R } = plateCorners(cols, depth, st.lift);
      const H = ISO_WALL_H + (st.top ? ISO_ROOF_H : 0);
      for (const p of [L, R]) {
        c.moveTo(X(p), Y(p, -ISO_SLAB_H));
        c.lineTo(X(p), Y(p, H));
      }
      c.moveTo(X(L), Y(L));
      c.lineTo(X(F), Y(F));
      c.lineTo(X(R), Y(R));
      if (st.top) {
        c.moveTo(X(L), Y(L, H));
        c.lineTo(X(F), Y(F, H));
        c.lineTo(X(R), Y(R, H));
        c.lineTo(X(B), Y(B, H));
        c.closePath();
      }
    }
  };
  const paint = () => {
    bands();
    c.fillStyle = K.band;
    c.fill();
    lines();
    c.lineJoin = 'miter';
    c.strokeStyle = K.line;
    c.lineWidth = line;
    c.stroke();
    c.strokeStyle = K.core;
    c.lineWidth = core;
    c.stroke();
  };
  // The floor in focus as drawn (its plate, walls and slab): outside it at full strength, over
  // it fainter.
  const f = plateCorners(cols, depth, focusLift);
  const focus = () => {
    c.moveTo(X(f.L), Y(f.L, -ISO_SLAB_H));
    c.lineTo(X(f.F), Y(f.F, -ISO_SLAB_H));
    c.lineTo(X(f.R), Y(f.R, -ISO_SLAB_H));
    c.lineTo(X(f.R), Y(f.R, ISO_WALL_H));
    c.lineTo(X(f.B), Y(f.B, ISO_WALL_H));
    c.lineTo(X(f.L), Y(f.L, ISO_WALL_H));
    c.closePath();
  };
  c.save();
  c.beginPath();
  c.rect(0, 0, c.canvas.width, c.canvas.height);
  focus();
  c.clip('evenodd');
  paint();
  c.restore();
  c.save();
  c.beginPath();
  focus();
  c.clip();
  c.globalAlpha = ISO_OUTLINE_OVER_ALPHA;
  paint();
  c.restore();
  // The labels, by each storey's front corner, on top of everything.
  c.save();
  const px = Math.max(
    Math.round(ISO_OUTLINE_LABEL_MIN_PX * dpr),
    Math.round(ISO_OUTLINE_LABEL_PX * s),
  );
  c.font = `${px}px ${PIXEL_FONT_FAMILY}`;
  c.textBaseline = 'middle';
  c.textAlign = 'left';
  const pad = Math.round(px / 3);
  const edge = Math.max(1, Math.round(dpr));
  for (const st of storeys) {
    const { F } = plateCorners(cols, depth, st.lift);
    const w = Math.ceil(c.measureText(st.label).width);
    const bh = Math.round(px * 1.3);
    const tx = Math.round(o.x + (F.x + ISO_OUTLINE_LABEL_INSET) * s) + pad;
    const ty = Math.round(o.y + (F.y - ISO_OUTLINE_LABEL_INSET) * s) - Math.round(bh / 2);
    c.fillStyle = K.edge;
    c.fillRect(
      tx - pad - edge,
      ty - Math.round(bh / 2) - edge,
      w + 2 * pad + 2 * edge,
      bh + 2 * edge,
    );
    c.fillStyle = K.back;
    c.fillRect(tx - pad, ty - Math.round(bh / 2), w + 2 * pad, bh);
    c.fillStyle = K.label;
    c.fillText(st.label, tx, ty);
  }
  c.restore();
}
