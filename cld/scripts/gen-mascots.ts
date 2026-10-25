/**
 * CH-3: the four office mascots (Coral, Byte, Puff, Tori), drawn from code: no traced or copied
 * art (design note §5, candidate C "tall chunky"). Writes one colour-indexed sheet per species to
 * webview-ui/src/cld/characters/mascots/<species>.json (palette, 21 frames, anchors, faces) and
 * preview PNGs, rendered through the office compositor, to cld/artifacts/ch3/. Run:
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

const root = path.resolve(__dirname, '../..');
const OUT = path.join(root, 'webview-ui/src/cld/characters/mascots');
const PREVIEW = path.join(root, 'cld/artifacts/ch3');
const FW = 16;
const FH = 32;
const LEG = 3;
/** Standing body bottom row: legs below it end on row 29 (outline 30, like a person's feet). */
const STAND_BOTTOM = 29 - LEG;
const SEAT_BOTTOM = 24;
const SEAT_PRESS = 2;

type View = 'down' | 'up' | 'right';
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

interface Species {
  id: string;
  outline: string;
  ramps: Record<string, Ramp>;
  /** The ramp the look's colour recolours (its mid is the default colour). */
  body: string;
  leg: string;
  /** Body width seen from the side (front and back are 14). */
  sideW: number;
  shape(u: number, v: number, w: number, h: number, view: View): boolean;
  region?(u: number, v: number, w: number, h: number, view: View): string | null;
  extras(add: Add, w: number, h: number, view: View): void;
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
];

/** Tori's cap height: the face and the tie sit just under it. */
const capOf = (_h: number) => 7;

// ── one frame ───────────────────────────────────────────────────────────────

interface Built {
  /** '#rrggbb' or null per pixel. */
  px: (string | null)[][];
  face: [number, number] | null;
  head: [number, number, number];
  top: number;
  sip: [number, number];
}

function build(sp: Species, view: View, pose: Pose): Built {
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
      if (sp.shape(u, sv, bw, bh, view))
        set(x0 + u, y0 + v, sp.region?.(u, sv, bw, bh, view) ?? sp.body);
  }
  sp.extras((u, v, r) => set(x0 + u, y0 + v, r), bw, bh, view);
  let top = FH;
  for (let y = 0; y < FH && top === FH; y++) if (reg[y].some(Boolean)) top = y;

  const leg = 'leg:' + sp.leg;
  const paw = 'paw:' + sp.body;
  const c = bw / 2;
  if (!seated) {
    const long = pose === 'walkA' ? 0 : pose === 'walkB' ? 1 : -1;
    const legsAt = [c - 3, c + 1];
    if (view === 'right' && bob) {
      legsAt[0] -= 1; // a stride seen from the side
      legsAt[1] += 1;
    }
    legsAt.forEach((lu, i) => {
      const len = LEG + (i === long ? bob : 0);
      for (let k = 0; k < len; k++) for (const du of [0, 1]) set(x0 + lu + du, bottom + 1 + k, leg);
    });
  } else {
    const lift = pose === 'type1' ? 1 : 0;
    const typing = pose.startsWith('type');
    if (view === 'up') {
      // paws just outside the body, reaching for the keyboard: visible from behind
      const pv = 8;
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
      for (const fu of [c - 4, c + 2]) for (const du of [0, 1]) set(x0 + fu + du, bottom + 1, leg);
      if (typing)
        for (const [u, dv] of [
          [-1, -lift],
          [bw, lift - 1],
        ] as const)
          for (const dy of [0, 1]) set(x0 + u, y0 + rows - 4 + dv + dy, paw);
    } else {
      set(x0 + bw - 3, bottom + 1, leg);
      set(x0 + bw - 2, bottom + 1, leg);
      if (typing) {
        set(x0 + bw, y0 + 9 - lift, paw);
        set(x0 + bw, y0 + 10 - lift, paw);
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
    const x = Math.round(x0 + u);
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

  const fu = seated && view === 'up' ? null : ([x0, y0] as [number, number]);
  const ey = Math.round(bh * 0.36);
  return {
    px: fin,
    face: view === 'up' ? null : fu,
    head: [x0, y0, bw],
    top,
    sip: [x0 + Math.round(bw / 2), y0 + ey + 4],
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
  const { MASCOT_COLORS } = await import('../../core/src/cld/looks.js');
  const GEARS = [undefined, 'headset', 'beanie', 'sprout', 'crown'] as const;
  fs.mkdirSync(PREVIEW, { recursive: true });
  const Z = 4;
  const ids = ['tori', 'coral', 'byte', 'puff'] as const;
  // 1. every frame of every species, the office sheet layout
  const sheet = new Canvas(
    ids.length * (7 * FW * Z + 12) + 12,
    3 * (FH * Z + 6) + 12,
    [30, 30, 46],
  );
  ids.forEach((id, k) => {
    const look = composeMascot({ species: id }, MASCOTS[id]);
    (['down', 'up', 'right'] as const).forEach((view, r) =>
      look.sheet[view].forEach((f, i) =>
        sheet.blit(f, 12 + k * (7 * FW * Z + 12) + i * FW * Z, 12 + r * (FH * Z + 6), Z),
      ),
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
