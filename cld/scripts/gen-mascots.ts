/**
 * CH-3: the office mascots (Coral, Byte, Puff, Tori; 11-04: Kwak, Bugi, Moka, Mungge, Boo, Gasi,
 * Mora, Shoo from the ui-mock-1104 sheet), drawn from code: no traced or copied art (design note
 * §5, candidate C "tall chunky"). Writes one colour-indexed sheet per species to
 * webview-ui/src/cld/characters/mascots/<species>.json (palette, 21 frames, anchors, faces) and
 * preview PNGs, rendered through the office compositor, to cld/artifacts/mascots-1104/. Run:
 *
 *   npx tsx cld/scripts/gen-mascots.ts
 *
 * Frame order is the office sheet's (rows down, up, right; walk1 walk2 walk3 type1 type2 read1
 * read2). Seated frames (type, read) sit like a human's: the renderer lowers them 6 px, and the
 * body is pressed 2 rows so a seated mascot is no bulkier than a person. Nothing asymmetric is
 * drawn (left = the right row mirrored), and there is no text anywhere.
 */
import * as fs from 'fs';
import * as path from 'path';
import { PNG } from 'pngjs';

/* eslint-disable agent-tycoon/no-inline-colors -- an asset generator: its palette is pixel data, not UI styling */

const root = path.resolve(__dirname, '../..');
const OUT = path.join(root, 'webview-ui/src/cld/characters/mascots');
const PREVIEW = path.join(root, 'cld/artifacts/mascots-1104');
const FW = 16;
const FH = 32;
const LEG = 3;
/** Standing body bottom row: legs below it end on row 29 (outline 30, like a person's feet). */
const STAND_BOTTOM = 29 - LEG;
const SEAT_BOTTOM = 24;
const SEAT_PRESS = 2;

type View = 'down' | 'up' | 'right';
/** DIAG-1104: the three-quarter walking rows (facing lower right and upper right; the app mirrors
 *  them for the left diagonals). Drawn on the front (back) view, turned: see build(). */
type Diag = 'downRight' | 'upRight';
const DIAGS: Diag[] = ['downRight', 'upRight'];
const DIAG_POSES: Pose[] = ['walkA', 'stand', 'walkB'];
const diagBase = (d: Diag): View => (d === 'downRight' ? 'down' : 'up');
/** How far a turned view moves what is on the body (face, marks) and on top of it (ears, steam):
 *  toward the way it faces, the near edge taking the overflow off (the body box stays as it is). */
const DIAG_MARK_SHIFT = 2;
const DIAG_TOP_SHIFT = 1;
type Pose = 'walkA' | 'stand' | 'walkB' | 'type1' | 'type2' | 'read1' | 'read2';
const VIEWS: View[] = ['down', 'up', 'right'];
const POSES: Pose[] = ['walkA', 'stand', 'walkB', 'type1', 'type2', 'read1', 'read2'];
const EXPRS = ['smile', 'happy', 'focus', 'sleepy'] as const;
type Expr = (typeof EXPRS)[number];

interface Ramp {
  hi: string;
  mid: string;
  sh: string;
  dk: string;
}
type Tone = keyof Ramp;
type Put = (u: number, v: number, color: string) => void;
type Add = (u: number, v: number, ramp: string) => void;

const EYE = '#22161a';
const WHITE = '#ffffff';
const PAPER = '#f6efdc';
const PAPER_LINE = '#9a8f78';
/** The floor shadow under a mascot with no legs. */
const SHADOW = '#2c2838';

interface Species {
  id: string;
  outline: string;
  ramps: Record<string, Ramp>;
  /** The ramp the look's colour recolours (its mid is the default colour). */
  body: string;
  leg: string;
  /** Body width seen from the side (front and back are 14). */
  sideW: number;
  shape(u: number, v: number, w: number, h: number, view: View, pose: Pose): boolean;
  region?(u: number, v: number, w: number, h: number, view: View): string | null;
  extras(add: Add, w: number, h: number, view: View, pose: Pose): void;
  /** false: no legs (it floats, a shadow on the floor under it). */
  legs?: false;
  /** Standing leg columns (body-local u), default [c-3, c+1]. */
  legX?(view: View): [number, number];
  /** Drawn after the outline, with no outline of its own (steam, a falling grain, the booster). */
  overlay?(put: Put, w: number, view: View, pose: Pose): void;
  /** The head box gear sits on, body-local [u, v, width] (default: the whole body box). */
  head?(w: number, view: View): [number, number, number];
  /** The mouth row (body-local): where the rest drink goes (default 10). */
  mouthV?: number;
  /** The seated paws' row (body-local) where the body is wide enough to hold them (Mora's waist
   *  is not): default by view. */
  pawV?: number;
  /** DIAG-1104: how far the turned views move the face and marks (default DIAG_MARK_SHIFT). */
  diagShift?: number;
  texture?(u: number, v: number, h: number, ramp: string): boolean;
  /** Marks that are not the expression (blush, tie, screen, back panel). */
  fixed(put: Put, w: number, h: number, view: View, seated: boolean): void;
  /** Eyes and mouth for one expression, front (down) or side (right). */
  face(put: Put, w: number, h: number, view: View, expr: Expr): void;
  /** The 16×16 card portrait's top row in the standing front frame. */
  mugTop: number;
}

const corner = (u: number, v: number, w: number, h: number, k: number) =>
  Math.min(u, w - 1 - u) + Math.min(v, h - 1 - v) >= k;
const ellipse = (u: number, v: number, w: number, h: number, s = 1) =>
  ((u + 0.5 - w / 2) / (w / 2)) ** 2 + ((v + 0.5 - h / 2) / (h / 2)) ** 2 <= s;

/** Round eyes 2×3 with a highlight; ^ for happy, a line for sleepy, a brow for focus. */
function eye(put: Put, x: number, ey: number, expr: Expr, inner: 'left' | 'right' | null): void {
  if (expr === 'happy') {
    put(x, ey + 1, EYE);
    put(x + 1, ey, EYE);
    put(x + 2, ey + 1, EYE);
    return;
  }
  if (expr === 'sleepy') {
    put(x, ey + 1, EYE);
    put(x + 1, ey + 1, EYE);
    return;
  }
  put(x, ey, WHITE);
  put(x + 1, ey, EYE);
  for (const dy of [1, 2]) {
    put(x, ey + dy, EYE);
    put(x + 1, ey + dy, EYE);
  }
  if (expr === 'focus' && inner) put(inner === 'left' ? x : x + 1, ey - 1, EYE);
}

function frontEyes(put: Put, xl: number, xr: number, ey: number, expr: Expr): void {
  // happy eyes are 3 wide: the right one starts a pixel left so both stay symmetric
  eye(put, xl, ey, expr, 'right');
  eye(put, expr === 'happy' ? xr - 1 : xr, ey, expr, 'left');
}

function frontMouth(put: Put, w: number, my: number, col: string, expr: Expr): void {
  const c = w / 2;
  if (expr === 'sleepy') {
    put(c - 1, my, col);
    put(c, my, col);
    return;
  }
  if (expr === 'focus') {
    put(c - 1, my, col);
    put(c, my, col);
    return;
  }
  put(c - 2, my - 1, col);
  put(c - 1, my, col);
  put(c, my, col);
  put(c + 1, my - 1, col);
}

/** The side view: one eye near the front edge, the mouth at the edge. */
function sideFace(put: Put, w: number, ey: number, my: number, col: string, expr: Expr): void {
  eye(put, w - 4, ey, expr, 'left');
  if (expr === 'sleepy') put(w - 2, my, col);
  else if (expr === 'focus') {
    put(w - 3, my, col);
    put(w - 2, my, col);
  } else {
    put(w - 4, my - 1, col);
    put(w - 3, my, col);
    put(w - 2, my, col);
  }
}

const SPECIES: Species[] = [
  // Agent Tycoon's own: an acorn team lead with a textured cap and a red bow tie.
  {
    id: 'tori',
    outline: '#2e1c10',
    ramps: {
      acorn: { hi: '#f2c98c', mid: '#dda05c', sh: '#b07738', dk: '#6e4720' },
      cap: { hi: '#9a6640', mid: '#7a4a2a', sh: '#58321b', dk: '#38200f' },
    },
    body: 'acorn',
    leg: 'acorn',
    sideW: 12,
    shape: (u, v, w, h) =>
      ellipse(u, v + 1, w, h + 2, 1.05) || (v < h * 0.4 && u >= 1 && u <= w - 2),
    region: (_u, v, _w, h) => (v < capOf(h) ? 'cap' : null),
    extras(add, w, h) {
      const capH = capOf(h);
      for (let u = -1; u <= w; u++) add(u, capH - 1, 'cap');
      for (let u = 1; u <= w - 2; u++) add(u, -1, 'cap');
      const c = w / 2 - 1;
      add(c, -2, 'cap');
      add(c + 1, -3, 'cap');
    },
    texture: (u, v, h, ramp) =>
      ramp === 'cap' && v >= 0 && v < capOf(h) - 1 && (u + 2 * v) % 4 === 0,
    fixed(put, w, h, view, seated) {
      if (view === 'up') return;
      const ey = capOf(h) + 1;
      const blush = '#f08a6a';
      if (seated) {
        // pressed: no room under the mouth for the tie
        put(view === 'right' ? w - 2 : 1, ey + 3, blush);
        if (view === 'down') put(w - 2, ey + 3, blush);
        return;
      }
      const tie = '#e04848';
      const knot = '#8a2020';
      if (view === 'right') {
        put(w - 2, ey + 3, '#f08a6a');
        put(w - 2, ey + 6, tie);
        put(w - 1, ey + 5, tie);
        put(w - 1, ey + 7, tie);
        put(w - 1, ey + 6, knot);
        return;
      }
      put(1, ey + 3, '#f08a6a');
      put(w - 2, ey + 3, '#f08a6a');
      const c = w / 2;
      const ty = ey + 6;
      for (const [u, v] of [
        [-3, 0],
        [-2, 0],
        [1, 0],
        [2, 0],
        [-3, -1],
        [-3, 1],
        [2, -1],
        [2, 1],
      ])
        put(c + u, ty + v, tie);
      put(c - 1, ty, knot);
      put(c, ty, knot);
    },
    face(put, w, h, view, expr) {
      const ey = capOf(h) + 1;
      const mouth = '#5a3016';
      if (view === 'right') sideFace(put, w, ey, ey + 4, mouth, expr);
      else {
        frontEyes(put, 3, w - 5, ey, expr);
        frontMouth(put, w, ey + 4, mouth, expr);
      }
    },
    mugTop: 13,
  },
  // Claude-inspired: a warm coral loaf with two ear nubs, round eyes and blush.
  {
    id: 'coral',
    outline: '#3b1e1a',
    ramps: { coral: { hi: '#f7a17a', mid: '#ea7d55', sh: '#c55a3b', dk: '#8f3a26' } },
    body: 'coral',
    leg: 'coral',
    sideW: 12,
    shape: (u, v, w, h) => corner(u, v, w, h, 2),
    extras(add, w, _h, view) {
      const ears =
        view === 'right'
          ? [
              [2, 4],
              [w - 5, w - 3],
            ]
          : [
              [1, 3],
              [w - 4, w - 2],
            ];
      for (const [a, b] of ears) {
        for (let u = a; u <= b; u++) add(u, -1, 'coral');
        add((a + b) / 2, -2, 'coral');
      }
    },
    fixed(put, w, h, view) {
      const ey = Math.round(h * 0.36);
      if (view === 'right') put(w - 2, ey + 3, '#ff8b7a');
      else if (view === 'down') {
        put(1, ey + 3, '#ff8b7a');
        put(w - 2, ey + 3, '#ff8b7a');
      }
    },
    face(put, w, h, view, expr) {
      const ey = Math.round(h * 0.36);
      const mouth = '#6a2418';
      if (view === 'right') sideFace(put, w, ey, ey + 4, mouth, expr);
      else {
        frontEyes(put, 3, w - 5, ey, expr);
        frontMouth(put, w, ey + 4, mouth, expr);
      }
    },
    mugTop: 9,
  },
  // Codex/GPT-inspired: a CRT-head robot with an antenna bulb and an LED face (no glyphs).
  {
    id: 'byte',
    outline: '#14243a',
    ramps: {
      casing: { hi: '#7cc3f5', mid: '#3d8fdc', sh: '#2a63a8', dk: '#1a3f72' },
      trunk: { hi: '#6fe0d0', mid: '#2fb8a8', sh: '#1f8579', dk: '#145a52' },
      metal: { hi: '#9aa3b5', mid: '#6b7385', sh: '#4a5060', dk: '#2c303a' },
      bulb: { hi: '#fff0a0', mid: '#ffd23f', sh: '#d9a21c', dk: '#8a6410' },
    },
    body: 'casing',
    leg: 'metal',
    sideW: 12,
    shape: (u, v, w, h) => {
      const head = h - 3;
      if (v < head) return corner(u, v, w, head, 1);
      return u >= 2 && u <= w - 3;
    },
    region: (_u, v, _w, h) => (v >= h - 3 ? 'trunk' : null),
    extras(add, w, _h, view) {
      const c = w / 2 - 1;
      add(c, -1, 'metal');
      add(c, -2, 'metal');
      for (const [u, v] of [
        [c, -3],
        [c + 1, -3],
        [c, -4],
        [c + 1, -4],
      ])
        add(u, v, 'bulb');
      if (view === 'right') return;
      for (const v of [8, 9]) {
        add(-1, v, 'metal');
        add(w, v, 'metal');
      }
    },
    fixed(put, w, h, view) {
      const head = h - 3;
      const screen = '#0f2233';
      if (view === 'up') {
        for (const v of [3, 5, 7]) for (let u = 3; u <= w - 4; u++) put(u, v, '#2a63a8');
        return;
      }
      if (view === 'right') {
        for (let v = 2; v <= head - 3; v++) for (const u of [w - 3, w - 2]) put(u, v, screen);
        return;
      }
      for (let v = 2; v <= head - 3; v++) for (let u = 2; u <= w - 3; u++) put(u, v, screen);
    },
    face(put, w, h, view, expr) {
      const head = h - 3;
      const led = '#6ff7e6';
      const ey = 4;
      const my = head - 4;
      if (view === 'right') {
        if (expr === 'sleepy') put(w - 2, ey + 1, led);
        else if (expr === 'happy') {
          put(w - 3, ey + 1, led);
          put(w - 2, ey, led);
        } else {
          put(w - 2, ey, led);
          put(w - 2, ey + 1, led);
          if (expr === 'focus') put(w - 3, ey - 1, led);
        }
        put(w - 3, my, led);
        if (expr !== 'sleepy' && expr !== 'focus') put(w - 2, my - 1, led);
        return;
      }
      for (const [x, inner] of [
        [4, 1],
        [w - 5, -1],
      ] as const) {
        if (expr === 'happy') {
          put(x - 1, ey + 1, led);
          put(x, ey, led);
          put(x + 1, ey + 1, led);
        } else if (expr === 'sleepy') {
          for (let k = -1; k <= 1; k++) put(x + k, ey + 1, led);
        } else {
          for (let k = 0; k < 3; k++) put(x, ey + k, led);
          if (expr === 'focus') put(x + inner, ey - 1, led);
        }
      }
      const c = w / 2;
      if (expr === 'sleepy' || expr === 'focus') {
        put(c - 1, my, led);
        put(c, my, led);
      } else {
        put(c - 2, my - 1, led);
        put(c - 1, my, led);
        put(c, my, led);
        put(c + 1, my - 1, led);
      }
    },
    mugTop: 8,
  },
  // Dots-inspired: a round mint monster with little horns, white eyes and one fang.
  {
    id: 'puff',
    outline: '#1d3a2a',
    ramps: {
      mint: { hi: '#a6ecc2', mid: '#6fd39a', sh: '#46a874', dk: '#2a6e4a' },
      horn: { hi: '#fff6dc', mid: '#f1dfae', sh: '#c9b07a', dk: '#7a6640' },
    },
    body: 'mint',
    leg: 'mint',
    sideW: 13,
    shape: (u, v, w, h) => ellipse(u, v, w, h, 1.12),
    extras(add, w, _h, view) {
      const horns =
        view === 'right'
          ? [
              [2, 1],
              [w - 5, -1],
            ]
          : [
              [2, 1],
              [w - 3, -1],
            ];
      for (const [u, out] of horns) {
        add(u, -1, 'horn');
        add(u + out, -1, 'horn');
        add(u, -2, 'horn');
      }
    },
    fixed() {},
    face(put, w, h, view, expr) {
      const ey = Math.round(h * 0.33);
      const ink = '#1d3a2a';
      const ball = (x: number, pupil: number) => {
        for (const dy of [0, 1, 2]) {
          put(x, ey + dy, WHITE);
          put(x + 1, ey + dy, WHITE);
        }
        put(x + pupil, ey + 1, EYE);
        put(x + pupil, ey + 2, EYE);
      };
      const my = ey + 5;
      if (view === 'right') {
        if (expr === 'sleepy' || expr === 'happy') eye(put, w - 4, ey, expr, null);
        else {
          ball(w - 4, 1);
          if (expr === 'focus') put(w - 4, ey - 1, EYE);
        }
        put(w - 4, my, ink);
        put(w - 3, my, ink);
        put(w - 2, my - 1, ink);
        if (expr !== 'sleepy') put(w - 3, my + 1, WHITE);
        return;
      }
      for (const [x, pupil, inner] of [
        [2, 1, 'right'],
        [w - 4, 0, 'left'],
      ] as const) {
        if (expr === 'sleepy' || expr === 'happy') eye(put, x, ey, expr, null);
        else {
          ball(x, pupil);
          if (expr === 'focus') put(inner === 'left' ? x : x + 1, ey - 1, EYE);
        }
      }
      if (expr === 'sleepy') {
        for (let u = w / 2 - 1; u <= w / 2; u++) put(u, my, ink);
        return;
      }
      for (let u = 3; u <= w - 4; u++) put(u, my, ink);
      put(3, my - 1, ink);
      put(w - 4, my - 1, ink);
      // the fang sits at the centre so the mirrored side view needs no second one
      if (expr !== 'focus') {
        put(w / 2 - 1, my + 1, WHITE);
        put(w / 2, my + 1, WHITE);
      }
    },
    mugTop: 8,
  },
  // ── 11-04 (ui-mock-1104, picked by the owner): same build, the mock's front views kept ──
  // Kwak: the rubber duck you explain your bug to. Big round head on a round body, a bill, a tuft.
  {
    id: 'kwak',
    outline: '#3a2a10',
    ramps: {
      duck: { hi: '#fff3a6', mid: '#ffd84a', sh: '#e0a82a', dk: '#a06a10' },
      bill: { hi: '#ffb36b', mid: '#ff8a3d', sh: '#d9601f', dk: '#8a3a10' },
    },
    body: 'duck',
    leg: 'bill',
    sideW: 13,
    shape: (u, v, w, _h, view) =>
      view === 'right'
        ? circ(u, v, w - 5.5, 4.6, 4.6, 4.6) ||
          circ(u, v, w / 2, 11, w / 2, 5.2) ||
          (u >= w - 2 && v >= 5 && v <= 6)
        : circ(u, v, 7, 4.6, 4.8, 4.6) || circ(u, v, 7, 11, 7, 5.2),
    region: (u, v, w, _h, view) =>
      view === 'right' && u >= w - 2 && v >= 5 && v <= 6 ? 'bill' : null,
    extras(add, w, _h, view) {
      if (view === 'right') {
        // the tuft leans back, the tail sticks up behind
        add(6, -1, 'duck');
        add(5, -2, 'duck');
        for (const [u, v] of [
          [0, 7],
          [0, 8],
          [1, 8],
        ])
          add(u, v, 'duck');
        return;
      }
      add(7, -1, 'duck');
      add(8, -2, 'duck');
      for (const v of [9, 10]) {
        add(-1, v, 'duck');
        add(w, v, 'duck');
      }
    },
    fixed(put, w, _h, view) {
      if (view === 'right') {
        for (const [u, v] of [
          [3, 10],
          [4, 10],
          [5, 10],
          [4, 11],
          [5, 11],
          [6, 11],
        ])
          put(u, v, '#e0a82a');
        put(w - 5, 6, '#ff9a8a');
        return;
      }
      if (view !== 'down') return;
      const bill = '#ff8a3d';
      const billSh = '#d9601f';
      for (let u = 5; u <= 8; u++) {
        put(u, 6, bill);
        put(u, 7, u === 5 || u === 8 ? bill : billSh);
      }
      put(3, 6, '#ff9a8a');
      put(w - 4, 6, '#ff9a8a');
    },
    face(put, w, _h, view, expr) {
      if (view === 'right') eye(put, w - 5, 3, expr, 'left');
      else frontEyes(put, 4, 8, 3, expr);
    },
    head: (w, view) => (view === 'right' ? [3, 0, w - 4] : [2, 0, 10]),
    mouthV: 7,
    mugTop: 8,
  },
  // Bugi: the bug itself, a friendly beetle. Dark head, round shell with spots and a seam, two
  // long antennae and little side legs.
  {
    id: 'bugi',
    outline: '#1e1424',
    ramps: {
      shell: { hi: '#ff8a7a', mid: '#e8504a', sh: '#b8323a', dk: '#7a1e28' },
      head: { hi: '#6a6478', mid: '#4a4458', sh: '#332e40', dk: '#1e1a28' },
    },
    body: 'shell',
    leg: 'head',
    sideW: 13,
    shape: (u, v, w, _h, view) =>
      view === 'right'
        ? circ(u, v, w - 4.5, 4.4, 4, 4.3) || circ(u, v, w / 2 - 0.5, 10.6, w / 2 - 0.5, 5.6)
        : circ(u, v, 7, 4, 4.3, 4.2) || circ(u, v, 7, 10.6, 7, 5.6),
    region: (u, v, w, _h, view) => {
      if (view === 'right') return v <= 7 && circ(u, v, w - 4.5, 4.4, 4, 4.3) ? 'head' : null;
      return v <= (view === 'up' ? 4 : 6) && circ(u, v, 7, 4, 4.3, 4.2) ? 'head' : null;
    },
    extras(add, w, _h, view) {
      const c = view === 'right' ? w - 5 : 7;
      // antennae in a V (seen from the side: one leans forward, one back)
      for (const [u, v] of [
        [-2, -1],
        [-3, -2],
        [-4, -3],
      ]) {
        add(c + u, v, 'head');
        add(c - 1 - u, v, 'head');
      }
      add(c - 5, -4, 'shell');
      add(c + 4, -4, 'shell');
      if (view === 'right') {
        add(-1, 12, 'head');
        add(w, 12, 'head');
        return;
      }
      for (const v of [9, 12]) {
        add(-1, v, 'head');
        add(w, v, 'head');
      }
    },
    fixed(put, w, _h, view) {
      const dk = '#7a1e28';
      const spot = (u: number, v: number, mirror: boolean) => {
        for (const [du, dv] of [
          [0, 0],
          [1, 0],
          [0, 1],
          [1, 1],
        ]) {
          put(u + du, v + dv, dk);
          if (mirror) put(w - 1 - u - du, v + dv, dk);
        }
      };
      if (view === 'right') {
        spot(1, 9, false);
        spot(4, 12, false);
        spot(6, 9, false);
        return;
      }
      for (let v = view === 'up' ? 5 : 7; v <= 15; v++) {
        put(6, v, dk);
        put(7, v, dk);
      }
      spot(2, 9, true);
      spot(3, 12, true);
    },
    face(put, w, _h, view, expr) {
      const ey = 2;
      const mouth = '#ff9a8a';
      const ball = (x: number, pupil: number, inner: 'left' | 'right') => {
        if (expr === 'happy' || expr === 'sleepy') {
          put(x, ey + 1, WHITE);
          put(x + 1, ey + 1, WHITE);
          if (expr === 'happy') put(x + pupil, ey, WHITE);
          return;
        }
        for (const dy of [0, 1, 2]) {
          put(x, ey + dy, WHITE);
          put(x + 1, ey + dy, WHITE);
        }
        put(x + pupil, ey + 1, EYE);
        put(x + pupil, ey + 2, EYE);
        if (expr === 'focus') put(inner === 'left' ? x : x + 1, ey - 1, WHITE);
      };
      if (view === 'right') {
        ball(w - 4, 1, 'left');
        put(w - 3, 6, mouth);
        put(w - 2, 6, mouth);
        return;
      }
      ball(4, 1, 'right');
      ball(w - 6, 0, 'left');
      put(6, 6, mouth);
      put(7, 6, mouth);
    },
    head: (w, view) => (view === 'right' ? [4, 0, w - 5] : [2, 0, 10]),
    mouthV: 6,
    mugTop: 8,
  },
  // Moka: the mug next to the keyboard. A cup with a handle (behind it seen from the back and the
  // side), coffee with foam and a wisp of steam that sways as it walks.
  {
    id: 'moka',
    outline: '#1a2a30',
    ramps: {
      mug: { hi: '#9de8dc', mid: '#56c4b4', sh: '#36988a', dk: '#226058' },
      coffee: { hi: '#c08a5a', mid: '#7a4a2a', sh: '#5a321a', dk: '#3a1e0e' },
    },
    body: 'mug',
    leg: 'mug',
    sideW: 12,
    legX: (view) => {
      const c = Math.round(cupOf(view)[2]);
      return [c - 3, c + 2];
    },
    shape: (u, v, _w, _h, view) => {
      const [l, r] = cupOf(view);
      if (u >= l && u <= r) return v === 1 || v === 15 ? u > l && u < r : v >= 2;
      // the handle: a ring whose hole the outline fills
      const out = view === 'down' ? u - r : l - u;
      if (out < 1 || out > 3 || v < 5 || v > 11) return false;
      return !(out <= 2 && v >= 7 && v <= 9) && !(out === 3 && (v === 5 || v === 11));
    },
    region: (u, v, _w, _h, view) => {
      const [l, r] = cupOf(view);
      return (v === 2 && u >= l + 2 && u <= r - 2) || (v === 3 && u > l && u < r) ? 'coffee' : null;
    },
    extras() {},
    fixed(put, _w, _h, view) {
      const [l, r, c] = cupOf(view);
      const foam = '#f4e6cc';
      put(c - 1, 2, foam);
      put(c, 2, foam);
      put(c + 1, 3, foam);
      if (view === 'down') {
        put(l + 1, 9, '#ff9a8a');
        put(r - 1, 9, '#ff9a8a');
      } else if (view === 'right') put(r - 5, 8, '#ff9a8a');
    },
    face(put, w, _h, view, expr) {
      const ink = '#1a2a30';
      if (view === 'right') {
        sideFace(put, w, 5, 9, ink, expr);
        return;
      }
      frontEyes(put, 2, 7, 5, expr);
      const my = 9;
      if (expr === 'sleepy' || expr === 'focus') {
        put(4, my, ink);
        put(5, my, ink);
        put(6, my, ink);
      } else {
        put(3, my - 1, ink);
        put(4, my, ink);
        put(5, my, ink);
        put(6, my, ink);
        put(7, my - 1, ink);
      }
    },
    overlay(put, _w, view, pose) {
      const c = Math.round(cupOf(view)[2]);
      const sway = pose === 'walkA' ? -1 : pose === 'walkB' ? 1 : 0;
      for (const a of [c - 2, c + 2])
        for (const [u, v] of [
          [a, -1],
          [a + 1, -2],
          [a + sway, -3],
        ])
          put(u, v, '#e8f0f2');
    },
    head: (_w, view) => {
      const [l, r] = cupOf(view);
      return [l, 1, r - l + 1];
    },
    mouthV: 9,
    mugTop: 8,
  },
  // Mungge: the cloud our servers live in. Three bumps on top, puffy sides, a soft bottom.
  {
    id: 'mungge',
    outline: '#1e3050',
    ramps: { sky: { hi: '#f2faff', mid: '#b4dcff', sh: '#7cb2e8', dk: '#4c80be' } },
    body: 'sky',
    leg: 'sky',
    sideW: 13,
    // the side view is the front with its middle column dropped
    shape: (u, v, w, _h, view) =>
      CLOUD[v]?.[view === 'right' && u >= Math.floor(w / 2) ? u + 1 : u] === 'X',
    extras() {},
    fixed(put, w, _h, view) {
      if (view === 'down') {
        put(2, 11, '#ff9ab8');
        put(w - 3, 11, '#ff9ab8');
      } else if (view === 'right') put(w - 5, 11, '#ff9ab8');
    },
    face(put, w, _h, view, expr) {
      if (view === 'right') sideFace(put, w, 8, 12, '#1e3050', expr);
      else {
        frontEyes(put, 4, 8, 8, expr);
        frontMouth(put, w, 12, '#1e3050', expr);
      }
    },
    head: (w) => [1, 4, w - 2],
    mouthV: 12,
    mugTop: 8,
  },
  // Boo: the 404 page that went looking for itself. A ghost with no legs: it floats over its
  // shadow, and its hem ripples as it moves.
  {
    id: 'boo',
    outline: '#2a2040',
    // hi is a hair off white so the eyes' white highlight is not a body slot
    ramps: { sheet: { hi: '#fdfcff', mid: '#efeaff', sh: '#c6bcec', dk: '#9488c8' } },
    body: 'sheet',
    leg: 'sheet',
    sideW: 13,
    legs: false,
    shape: (u, v, w, _h, _view, pose) => {
      if (v < 7) return circ(u, v, w / 2, 7, w / 2, 7);
      const ph = pose === 'walkA' ? 0 : pose === 'walkB' ? 2 : 1;
      if (v === 15) return (u + ph) % 4 < 2;
      return true;
    },
    extras(add, w, _h, view) {
      for (const v of [9, 10]) {
        if (view !== 'right') add(-1, v, 'sheet');
        add(w, v, 'sheet');
      }
    },
    fixed(put, w, _h, view) {
      if (view === 'down') {
        put(2, 9, '#ffb0d0');
        put(w - 3, 9, '#ffb0d0');
      } else if (view === 'right') put(w - 6, 9, '#ffb0d0');
    },
    face(put, w, _h, view, expr) {
      const ink = '#2a2040';
      const open = expr !== 'sleepy' && expr !== 'focus';
      const m = view === 'right' ? w - 3 : w / 2 - 1;
      if (view === 'right') eye(put, w - 4, 5, expr, 'left');
      else frontEyes(put, 4, 8, 5, expr);
      put(m, 10, ink);
      put(m + 1, 10, ink);
      if (open) {
        put(m, 9, ink);
        put(m + 1, 9, ink);
      }
    },
    mouthV: 9,
    mugTop: 6,
  },
  // Gasi: the desk cactus nobody waters. A ribbed column with two arms in a clay pot, one flower.
  {
    id: 'gasi',
    outline: '#1e2e18',
    ramps: {
      cactus: { hi: '#bfe88a', mid: '#86c95e', sh: '#57a03e', dk: '#336a26' },
      pot: { hi: '#f2a77a', mid: '#d47a4c', sh: '#a85632', dk: '#6c321c' },
      flower: { hi: '#ffd0e8', mid: '#ff8cc0', sh: '#e0609a', dk: '#a03068' },
    },
    body: 'cactus',
    leg: 'pot',
    sideW: 12,
    shape: (u, v, w, _h, view) => {
      if (v >= 10) return v <= 11 ? true : u >= 1 && u <= w - 2;
      if (view === 'right') {
        // a rounder column, the far arm behind it
        const column = u >= 3 && u <= 9 && !(v === 0 && (u === 3 || u === 9));
        const arm =
          (u <= 1 && v >= 3 && v <= 7 && !(v === 3 && u === 0)) || (u === 2 && v >= 6 && v <= 7);
        return column || arm;
      }
      const column = u >= 3 && u <= 10 && !(v === 0 && (u === 3 || u === 10));
      const left =
        (u <= 1 && v >= 2 && v <= 7 && !(v === 2 && u === 0)) || (u === 2 && v >= 6 && v <= 7);
      const right =
        (u >= 12 && v >= 4 && v <= 8 && !(v === 4 && u === 13)) || (u === 11 && v >= 7 && v <= 8);
      return column || left || right;
    },
    region: (_u, v) => (v >= 10 ? 'pot' : null),
    extras(add, _w, _h, view) {
      const c = view === 'right' ? 6 : 7;
      for (const [u, v] of [
        [-1, -1],
        [0, -1],
        [-2, -2],
        [1, -2],
      ])
        add(c + u, v, 'flower');
    },
    // the ribs stay off the face rows so the eyes read at 1x; the pot's rim line is shading so a
    // turned view does not move it
    texture: (u, v, _h, ramp) =>
      (ramp === 'cactus' && (u === 5 || u === 8) && (v === 1 || v === 8 || v === 9)) ||
      (ramp === 'pot' && v === 12),
    fixed(put, w, _h, view) {
      const spines =
        view === 'right'
          ? [
              [0, 5],
              [3, 9],
              [9, 9],
              [3, 2],
            ]
          : [
              [0, 4],
              [13, 6],
              [3, 9],
              [10, 9],
            ];
      for (const [u, v] of spines) put(u, v, '#f4ffd8');
      if (view === 'down') {
        put(3, 7, '#ff9a8a');
        put(w - 4, 7, '#ff9a8a');
      } else if (view === 'right') put(5, 7, '#ff9a8a');
    },
    face(put, w, _h, view, expr) {
      if (view === 'right') sideFace(put, w - 1, 3, 7, '#1e2e18', expr);
      else {
        frontEyes(put, 4, 8, 3, expr);
        frontMouth(put, w, 7, '#1e2e18', expr);
      }
    },
    head: (w, view) => (view === 'right' ? [3, 0, w - 5] : [2, 0, 10]),
    mouthV: 7,
    mugTop: 6,
  },
  // Mora: the build that is still running. An hourglass with a face in the top bulb, sand piling
  // in the bottom one, a grain falling through the waist while it walks or works.
  {
    id: 'mora',
    outline: '#2a1a3a',
    ramps: {
      frame: { hi: '#b89cf0', mid: '#8a68d8', sh: '#6248b0', dk: '#3e2c78' },
      glass: { hi: '#ffffff', mid: '#e4f2fa', sh: '#b8d6e6', dk: '#86a8bc' },
      sand: { hi: '#fff0b0', mid: '#f4cc6a', sh: '#d0a040', dk: '#8a6420' },
    },
    body: 'frame',
    leg: 'frame',
    sideW: 12,
    shape: (u, v, w) => {
      if (v <= 1 || v >= 14) return !((v === 0 || v === 15) && (u === 0 || u === w - 1));
      return Math.abs(u + 0.5 - w / 2) <= 1.6 + Math.abs(v + 0.5 - 8) * 0.95;
    },
    region: (u, v, w) => {
      if (v <= 1 || v >= 14) return null;
      const d = Math.abs(u + 0.5 - w / 2);
      if (v >= 10 && d <= (v - 9) * 1.6) return 'sand';
      if (v >= 7 && v <= 9 && d <= 1) return 'sand';
      return 'glass';
    },
    extras() {},
    fixed(put, w, _h, view) {
      if (view !== 'down') return;
      put(3, 5, '#ffb0c8');
      put(w - 4, 5, '#ffb0c8');
    },
    face(put, w, _h, view, expr) {
      if (view === 'right') sideFace(put, w - 2, 2, 6, '#2a1a3a', expr);
      else {
        frontEyes(put, 4, 8, 2, expr);
        frontMouth(put, w, 6, '#2a1a3a', expr);
      }
    },
    overlay(put, w, _view, pose) {
      if (pose !== 'stand') put(w / 2 - (pose === 'walkA' ? 1 : 0), 11, '#8a6420');
    },
    mouthV: 6,
    pawV: 12,
    // the glass narrows under the eyes: a smaller turn keeps the face on it
    diagShift: 1,
    mugTop: 6,
  },
  // Shoo: ship it. A little rocket with a pointed nose, side fins and a booster that puffs as it
  // walks.
  {
    id: 'shoo',
    outline: '#1e1a30',
    ramps: {
      // hi is a hair off white so the eyes' white highlight is not a body slot
      hull: { hi: '#fbfcff', mid: '#dfe3ee', sh: '#aab2c8', dk: '#6e7690' },
      nose: { hi: '#ff9a7a', mid: '#f0603e', sh: '#c03e2a', dk: '#7a2418' },
    },
    body: 'hull',
    leg: 'nose',
    sideW: 12,
    shape: (u, v, w) => {
      const d = Math.abs(u + 0.5 - w / 2);
      if (v <= 4) return d <= 1 + v * 1.1;
      if (v <= 12 && d <= 5) return true;
      if (v >= 13 && d <= 4) return true;
      // fins
      return (v >= 10 && v <= 14 && d > 5) || (v === 9 && d > 5 && d <= 6);
    },
    region: (u, v, w) => {
      const d = Math.abs(u + 0.5 - w / 2);
      return v <= 3 || d > 5 || v >= 14 ? 'nose' : null;
    },
    extras() {},
    fixed(put, w, _h, view) {
      for (let u = 3; u <= w - 4; u++) put(u, 12, '#6e7690');
      if (view === 'down') {
        put(3, 9, '#ff9ab8');
        put(w - 4, 9, '#ff9ab8');
      } else if (view === 'right') put(w - 6, 9, '#ff9ab8');
    },
    face(put, w, _h, view, expr) {
      if (view === 'right') sideFace(put, w, 5, 9, '#1e1a30', expr);
      else {
        frontEyes(put, 4, 8, 5, expr);
        frontMouth(put, w, 9, '#1e1a30', expr);
      }
    },
    overlay(put, w, _view, pose) {
      if (pose !== 'walkA' && pose !== 'walkB') return;
      const hot = pose === 'walkA' ? '#ffd23f' : '#ff8a3d';
      put(w / 2 - 1, 17, hot);
      put(w / 2, 17, hot);
      put(w / 2 - (pose === 'walkA' ? 1 : 0), 18, '#ffd23f');
    },
    head: (w) => [1, 3, w - 2],
    mouthV: 9,
    mugTop: 6,
  },
];

const circ = (u: number, v: number, cx: number, cy: number, rx: number, ry: number) =>
  ((u + 0.5 - cx) / rx) ** 2 + ((v + 0.5 - cy) / ry) ** 2 <= 1;

/** Moka's cup per view, body-local [left, right, centre]: the handle is right of it from the
 *  front and left of it from the back and the side (the side box is 12 wide). */
const cupOf = (view: View): [number, number, number] =>
  view === 'down' ? [0, 10, 5] : view === 'up' ? [3, 13, 8] : [3, 11, 7];

/** Mungge, front: three bumps, puffy sides (the notch on row 10), a rounded bottom. */
const CLOUD = [
  '..............',
  '..............',
  '..............',
  '.....XXXX.....',
  '....XXXXXX....',
  '.XX.XXXXXX.XX.',
  'XXXXXXXXXXXXXX',
  'XXXXXXXXXXXXXX',
  'XXXXXXXXXXXXXX',
  'XXXXXXXXXXXXXX',
  '.XXXXXXXXXXXX.',
  'XXXXXXXXXXXXXX',
  'XXXXXXXXXXXXXX',
  'XXXXXXXXXXXXXX',
  '.XXXXXXXXXXXX.',
  '...XXXXXXXX...',
];

/** Tori's cap height: the face and the tie sit just under it. */
const capOf = (_h: number) => 7;

// ── one frame ───────────────────────────────────────────────────────────────

interface Built {
  /** '#rrggbb' or null per pixel. */
  px: (string | null)[][];
  /** True where the body (not its outline) is. */
  body: boolean[][];
  face: [number, number] | null;
  head: [number, number, number];
  top: number;
  sip: [number, number];
}

function build(sp: Species, want: View | Diag, pose: Pose): Built {
  const view: View = want === 'downRight' || want === 'upRight' ? diagBase(want) : want;
  // a three-quarter view: the front (back) turned toward the right
  const turn = want === view ? 0 : view === 'down' ? 1 : -1;
  const seated = pose.startsWith('type') || pose.startsWith('read');
  const bw = view === 'right' ? sp.sideW : 14;
  const bh = 16;
  const rows = seated ? bh - SEAT_PRESS : bh;
  const bob = pose === 'walkA' || pose === 'walkB' ? 1 : 0;
  const bottom = seated ? SEAT_BOTTOM : STAND_BOTTOM - bob;
  const y0 = bottom - rows + 1;
  const x0 = Math.floor((FW - bw) / 2);
  // Seated: the body is pressed by dropping two rows above the rounded bottom, so the head and
  // the face keep their standing offsets (the anchors only move with the bob).
  const srcRow = (v: number) => (seated && v >= bh - 2 - SEAT_PRESS ? v + SEAT_PRESS : v);
  const reg: (string | null)[][] = Array.from({ length: FH }, () => Array(FW).fill(null));
  const set = (x: number, y: number, r: string) => {
    x = Math.round(x);
    if (x >= 0 && y >= 0 && x < FW && y < FH) reg[y][x] = r;
  };
  for (let v = 0; v < rows; v++) {
    const sv = srcRow(v);
    for (let u = 0; u < bw; u++)
      if (sp.shape(u, sv, bw, bh, view, pose))
        set(x0 + u, y0 + v, sp.region?.(u, sv, bw, bh, view) ?? sp.body);
  }
  sp.extras(
    (u, v, r) => set(x0 + u + (v < 0 ? turn * DIAG_TOP_SHIFT : 0), y0 + v, r),
    bw,
    bh,
    view,
    pose,
  );
  let top = FH;
  for (let y = 0; y < FH && top === FH; y++) if (reg[y].some(Boolean)) top = y;

  const leg = 'leg:' + sp.leg;
  const paw = 'paw:' + sp.body;
  const c = bw / 2;
  const legs = sp.legs !== false;
  if (!seated && legs) {
    const long = pose === 'walkA' ? 0 : pose === 'walkB' ? 1 : -1;
    const legsAt = sp.legX?.(view) ?? [c - 3, c + 1];
    if ((view === 'right' || turn) && bob) {
      legsAt[0] -= 1; // a stride seen from the side (or three quarters)
      legsAt[1] += 1;
    }
    legsAt.forEach((lu, i) => {
      const len = LEG + (i === long ? bob : 0);
      for (let k = 0; k < len; k++) for (const du of [0, 1]) set(x0 + lu + du, bottom + 1 + k, leg);
    });
  } else if (seated) {
    const lift = pose === 'type1' ? 1 : 0;
    const typing = pose.startsWith('type');
    if (view === 'up') {
      // paws just outside the body, reaching for the keyboard: visible from behind
      const pv = sp.pawV ?? 8;
      const sides: Array<[number, number]> = typing
        ? [
            [-1, -lift],
            [bw, lift - 1],
          ]
        : [
            [-1, -1],
            [bw, -1],
          ];
      for (const [u, dv] of sides) {
        set(x0 + u, y0 + pv + dv, paw);
        set(x0 + u, y0 + pv + dv + 1, paw);
      }
    } else if (view === 'down') {
      // stubby feet under the seat, paws at the sides reaching forward for the keyboard
      if (legs)
        for (const fu of [c - 4, c + 2])
          for (const du of [0, 1]) set(x0 + fu + du, bottom + 1, leg);
      if (typing)
        for (const [u, dv] of [
          [-1, -lift],
          [bw, lift - 1],
        ] as const)
          for (const dy of [0, 1]) set(x0 + u, y0 + (sp.pawV ?? rows - 4) + dv + dy, paw);
    } else {
      if (legs) {
        set(x0 + bw - 3, bottom + 1, leg);
        set(x0 + bw - 2, bottom + 1, leg);
      }
      if (typing) {
        const pv = sp.pawV ?? 9;
        set(x0 + bw, y0 + pv - lift, paw);
        set(x0 + bw, y0 + pv + 1 - lift, paw);
      }
    }
  }

  // shading: top-left light, three tones, the ramp's own darkest unused (outline is the species')
  const out: (string | null)[][] = Array.from({ length: FH }, () => Array(FW).fill(null));
  const same = (x: number, y: number, r: string) =>
    x >= 0 && y >= 0 && x < FW && y < FH && reg[y][x] === r;
  const box: Record<string, [number, number]> = {};
  reg.forEach((row, y) =>
    row.forEach((r) => {
      if (!r) return;
      const b = (box[r] ??= [y, y]);
      b[0] = Math.min(b[0], y);
      b[1] = Math.max(b[1], y);
    }),
  );
  for (let y = 0; y < FH; y++)
    for (let x = 0; x < FW; x++) {
      const r = reg[y][x];
      if (!r) continue;
      if (r.startsWith('leg:')) {
        out[y][x] = sp.ramps[r.slice(4)].sh;
        continue;
      }
      if (r.startsWith('paw:')) {
        out[y][x] = sp.ramps[r.slice(4)].hi;
        continue;
      }
      const R = sp.ramps[r];
      const [a, b] = box[r];
      const t = (y - a) / Math.max(1, b - a + 1);
      let tone: Tone = 'mid';
      if (!same(x, y - 1, r) || (!same(x - 1, y, r) && t < 0.5)) tone = 'hi';
      if (t >= 0.75 || (!same(x + 1, y, r) && t >= 0.3) || !same(x, y + 1, r)) tone = 'sh';
      if (sp.texture?.(x - x0, y - y0, bh, r)) tone = 'sh';
      out[y][x] = R[tone];
    }
  const put: Put = (u, v, color) => {
    const x = Math.round(x0 + u + turn * (sp.diagShift ?? DIAG_MARK_SHIFT));
    const y = y0 + v;
    if (x >= 0 && y >= 0 && x < FW && y < FH && reg[y][x]) out[y][x] = color;
  };
  sp.fixed(put, bw, bh, view, seated);
  if (seated && pose.startsWith('read') && view !== 'up') {
    // a sheet of paper held low in front (down) or at the front edge (right), below the face;
    // the paws holding it bob, the sheet stays put
    const [pu, pw, ph] = view === 'down' ? [c - 3, 6, 4] : [bw - 1, 2, 4];
    // front: under every species' mouth (Tori's is lowest, row 12); side: held up at the chest
    const pv = view === 'down' ? 13 : 10;
    for (let v = 0; v < ph; v++)
      for (let u = 0; u < pw; u++) {
        const x = x0 + pu + u;
        const y = y0 + pv + v;
        if (x < 0 || x >= FW || y >= FH) continue;
        const line = view === 'down' && v % 2 === 1 && u > 0 && u < pw - 1;
        out[y][x] = line || (view === 'right' && u === 0) ? PAPER_LINE : PAPER;
        reg[y][x] = 'paper';
      }
    const lift = pose === 'read1' ? 0 : 1;
    const hands = view === 'down' ? [pu - 1, pu + pw] : [pu - 1];
    for (const hu of hands) {
      const x = x0 + hu;
      const y = y0 + pv + 1 - lift;
      if (x < 0 || x >= FW) continue;
      out[y][x] = sp.ramps[sp.body].hi;
      reg[y][x] = paw;
    }
  }

  // outline: every transparent pixel touching a filled one, plus a 1 px edge around paws drawn
  // over the body (front typing) so they read as hands
  const fin = out.map((row) => row.slice());
  for (let y = 0; y < FH; y++)
    for (let x = 0; x < FW; x++) {
      const r = reg[y][x];
      const near = (dx: number, dy: number) => reg[y + dy]?.[x + dx] ?? null;
      if (!r) {
        if ([near(1, 0), near(-1, 0), near(0, 1), near(0, -1)].some(Boolean))
          fin[y][x] = sp.outline;
      } else if (!r.startsWith('paw:') && near(0, 1)?.startsWith('paw:') && view === 'down')
        fin[y][x] = sp.outline;
    }
  const raw: Put = (u, v, color) => {
    const x = Math.round(x0 + u + (v < 0 ? turn * DIAG_TOP_SHIFT : 0));
    const y = y0 + v;
    if (x >= 0 && y >= 0 && x < FW && y < FH) fin[y][x] = color;
  };
  sp.overlay?.(raw, bw, view, pose);
  // a floater's shadow stays on the floor (feet row) while it bobs
  if (!legs && !seated)
    for (let x = Math.round(x0 + c) - 3; x <= Math.round(x0 + c) + 2; x++)
      fin[STAND_BOTTOM + LEG][x] = SHADOW;

  const fu = seated && view === 'up' ? null : ([x0, y0] as [number, number]);
  const ey = Math.round(bh * 0.36);
  const [hu, hv, hw] = sp.head?.(bw, view) ?? [0, 0, bw];
  return {
    px: fin,
    body: reg.map((row) => row.map((r) => !!r && !r.startsWith('leg:'))),
    face: view === 'up' ? null : fu,
    head: [x0 + hu, y0 + hv, hw],
    top,
    sip: [x0 + Math.round(bw / 2), y0 + (sp.mouthV ?? ey + 4)],
  };
}

// ── colour slots ────────────────────────────────────────────────────────────

const SLOT_CHARS = 'abcefghijklmnpqrstuvwxyz0123456789ABCEFGIJKLNOPQRTUVWXYZ';

function mascot(sp: Species) {
  const palette: Record<string, string> = { o: sp.outline };
  const byHex = new Map<string, string>([[sp.outline, 'o']]);
  const body = sp.ramps[sp.body];
  const bodySlots = 'HMSD';
  (['hi', 'mid', 'sh', 'dk'] as Tone[]).forEach((tone, i) => {
    palette[bodySlots[i]] = body[tone];
    byHex.set(body[tone], bodySlots[i]);
  });
  let next = 0;
  const slot = (hex: string) => {
    let ch = byHex.get(hex);
    if (!ch) {
      ch = SLOT_CHARS[next++];
      if (!ch) throw new Error(`${sp.id}: too many colours`);
      byHex.set(hex, ch);
      palette[ch] = hex;
    }
    return ch;
  };
  const frames: Record<View, string[][]> = { down: [], up: [], right: [] };
  const anchors: Record<
    View,
    Array<{ face: [number, number] | null; head: number[]; top: number }>
  > = { down: [], up: [], right: [] };
  let sip: [number, number] = [8, 17];
  for (const view of VIEWS)
    for (const pose of POSES) {
      const b = build(sp, view, pose);
      frames[view].push(b.px.map((row) => row.map((c) => (c ? slot(c) : '.')).join('')));
      anchors[view].push({ face: b.face, head: b.head, top: b.top });
      if (view === 'down' && pose === 'stand') sip = b.sip;
    }
  const faces: Record<string, Record<string, Array<[number, number, string]>>> = {};
  for (const expr of EXPRS) {
    faces[expr] = {};
    for (const view of ['down', 'right'] as const) {
      const bw = view === 'right' ? sp.sideW : 14;
      const px: Array<[number, number, string]> = [];
      sp.face((u, v, color) => px.push([Math.round(u), v, slot(color)]), bw, 16, view, expr);
      faces[expr][view] = px;
    }
  }
  // after the faces: the slots the rows above use keep their letters
  // DIAG-1104: the three-quarter walking rows, their anchors and the turned faces (the front's,
  // moved like the marks, without what falls off the near edge)
  const diag = {
    $comment:
      'DIAG-1104: the three-quarter walking rows, facing lower right (downRight, with a face) and upper right (upRight), 3 frames each (walk1 stand walk3) in the same slots; anchors as above; faces[expr].downRight offsets from its face anchor. The left diagonals are these mirrored; seated frames stay the front and back ones.',
    frames: {} as Record<Diag, string[][]>,
    anchors: {} as Record<
      Diag,
      Array<{ face: [number, number] | null; head: number[]; top: number }>
    >,
    faces: {} as Record<string, Partial<Record<Diag, Array<[number, number, string]>>>>,
  };
  for (const d of DIAGS) {
    diag.frames[d] = [];
    diag.anchors[d] = [];
    for (const pose of DIAG_POSES) {
      const b = build(sp, d, pose);
      diag.frames[d].push(b.px.map((row) => row.map((c) => (c ? slot(c) : '.')).join('')));
      diag.anchors[d].push({ face: b.face, head: b.head, top: b.top });
    }
  }
  const turned = build(sp, 'downRight', 'stand');
  const [fx, fy] = turned.face!;
  for (const expr of EXPRS) {
    const px: Array<[number, number, string]> = [];
    sp.face(
      (u, v, color) => {
        const du = Math.round(u) + (sp.diagShift ?? DIAG_MARK_SHIFT);
        if (turned.body[fy + v]?.[fx + du]) px.push([du, v, slot(color)]);
      },
      14,
      16,
      'down',
      expr,
    );
    diag.faces[expr] = { downRight: px };
  }
  return {
    species: sp.id,
    $comment:
      'Generated by cld/scripts/gen-mascots.ts (original art drawn in code). Frames: rows down/up/right x walk1 walk2 walk3 type1 type2 read1 read2, 16x32, one palette slot per pixel (. transparent). body = the slots (hi mid sh dk) the look colour recolours. anchors: face = where faces[expr][row] offsets start (null: no face seen), head = [x, y, width] of the head box, top = topmost head row. mug = card portrait 16x16 top-left, sip = the mouth in the standing front frame.',
    palette,
    body: bodySlots,
    color: body.mid,
    frames,
    anchors,
    faces,
    mug: [0, sp.mugTop],
    sip,
    diag,
  };
}

// ── previews ───────────────────────────────────────────────────────────────

class Canvas {
  readonly png: PNG;
  constructor(
    readonly w: number,
    readonly h: number,
    bg: [number, number, number],
  ) {
    this.png = new PNG({ width: w, height: h });
    for (let i = 0; i < w * h; i++) this.png.data.set([...bg, 255], i * 4);
  }
  blit(sprite: string[][], x: number, y: number, z: number): void {
    sprite.forEach((row, sy) =>
      row.forEach((c, sx) => {
        if (!c) return;
        const rgb = [1, 3, 5].map((k) => parseInt(c.slice(k, k + 2), 16));
        for (let j = 0; j < z; j++)
          for (let i = 0; i < z; i++) {
            const px = x + sx * z + i;
            const py = y + sy * z + j;
            if (px < 0 || py < 0 || px >= this.w || py >= this.h) continue;
            this.png.data.set([...rgb, 255], (py * this.w + px) * 4);
          }
      }),
    );
  }
  save(file: string): void {
    fs.writeFileSync(file, PNG.sync.write(this.png));
    console.log(path.relative(root, file));
  }
}

async function previews(): Promise<void> {
  const { composeMascot, MASCOTS } = await import('../../webview-ui/src/cld/characters/compose.js');
  const { MASCOT_COLORS, MASCOT_SPECIES } = await import('../../core/src/cld/looks.js');
  const GEARS = [undefined, 'headset', 'beanie', 'sprout', 'crown'] as const;
  fs.mkdirSync(PREVIEW, { recursive: true });
  const Z = 4;
  const ids = MASCOT_SPECIES;
  // 1. every frame of every species, the office sheet layout, four species to a row
  const [bw, bh, cols] = [7 * FW * Z + 12, 3 * (FH * Z + 6) + 12, 4];
  const sheet = new Canvas(cols * bw + 12, Math.ceil(ids.length / cols) * bh + 12, [30, 30, 46]);
  ids.forEach((id, k) => {
    const look = composeMascot({ species: id }, MASCOTS[id]);
    const [bx, by] = [12 + (k % cols) * bw, 12 + Math.floor(k / cols) * bh];
    (['down', 'up', 'right'] as const).forEach((view, r) =>
      look.sheet[view].forEach((f, i) => sheet.blit(f, bx + i * FW * Z, by + r * (FH * Z + 6), Z)),
    );
  });
  sheet.save(path.join(PREVIEW, 'mascots-sheets.png'));
  // 2. colours x expressions x headgear on the standing front frame, plus the card portrait
  const cw = FW * Z + 6;
  const vary = new Canvas(14 * cw + 40, ids.length * (FH * Z + 8) + 12, [30, 30, 46]);
  ids.forEach((id, r) => {
    const y = 12 + r * (FH * Z + 8);
    let x = 12;
    const put = (look: Parameters<typeof composeMascot>[0]) => {
      vary.blit(composeMascot(look, MASCOTS[id]).sheet.down[1], x, y, Z);
      x += cw;
    };
    for (const color of MASCOT_COLORS[id]) put({ species: id, color });
    x += 8;
    for (const expr of EXPRS) put({ species: id, expr });
    x += 8;
    for (const gear of GEARS) put({ species: id, gear });
    const mug = composeMascot({ species: id }, MASCOTS[id]).mugshot;
    if (mug) vary.blit(mug, x + 8, y + 8, Z);
  });
  vary.save(path.join(PREVIEW, 'mascots-variants.png'));
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT, { recursive: true });
  for (const sp of SPECIES) {
    const file = path.join(OUT, `${sp.id}.json`);
    fs.writeFileSync(file, JSON.stringify(mascot(sp)) + '\n');
    console.log(path.relative(root, file));
  }
  if (!process.argv.includes('--no-preview')) await previews();
}

void main();
