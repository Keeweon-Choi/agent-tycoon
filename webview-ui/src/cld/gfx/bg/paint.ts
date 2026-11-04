/**
 * BACKGROUND painter: the surroundings of the isometric building as one offscreen picture, one
 * canvas px per iso px (the renderer scales it by the zoom, nearest-neighbour, like every other
 * piece). The ground is classified per pixel from the layout's tile grid (layout.ts), so roads,
 * pavements and plots sit exactly on the building's own floor tiles; what stands on it is drawn
 * back to front at the building's own storey scale (building-a-1104). There is no horizon: the
 * ground runs on until the fog ring (fog.ts) covers it. One layout, two palettes (palette.json):
 * the palette is the only thing that differs between day and night.
 */
import type { BackgroundMix } from '../../../../../core/src/messages.js';
import {
  BG_BAY_PX,
  BG_HOUSE_GLASS,
  BG_HOUSE_ROOF_STEPS,
  BG_LAMP_HEIGHT,
  BG_OBJECT_REACH,
  BG_SPRITE_CACHE_MAX,
  BG_TOWER_STOREYS,
  BG_TREE_TRUNK,
  ISO_GLASS_BAND,
  ISO_HALF_H,
  ISO_HALF_W,
  ISO_STOREY_H,
  rgbaOf,
} from '../../../constants.js';
import {
  axisCell,
  type BgObject,
  type Footprint,
  groundAt,
  hash,
  objectBox,
  objectsIn,
  type PlotKind,
  plotKind,
  plotsIn,
} from './layout.js';
import PALETTES from './palette.json';

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** What one picture is made of: the same spec always paints the same picture. */
export interface PaintSpec {
  seed: number;
  mix: BackgroundMix;
  night: boolean;
  fp: Footprint;
  /** The building's box (iso px): nothing tall stands in front of it. */
  avoid: Box;
  /** The part of the world painted (whole iso px). */
  region: Box;
}

interface Body {
  top: string;
  left: string;
  right: string;
  edge: string;
  off: string;
  litL: string;
  litR: string;
  p: number;
}
interface Palette {
  /** The fog ring (fog.ts): its body, the lit top of a puff, a puff's shaded side. */
  fog: { body: string; lit: string; shade: string };
  ground: Record<
    | 'road' | 'road2' | 'dash' | 'walk' | 'walkJ' | 'curb' | 'plazaJ' | 'lot' | 'lotJ' | 'water'
    | 'sand' | 'ghost' | 'ghostJ' | 'ghostEdge',
    string
  > & { plaza: string[]; grass: string[] };
  tree: { shadow: string; trunk: string; leafD: string; leafM: string; leafL: string; spark: string | null; flower: string | null };
  lamp: { pole: string; on: string; pool: string; poolK: number; halo: string | null; haloK: number };
  tower: Body;
  house: Body & { roofs: string[][] };
  mainGlow: string | null;
  mainGlowK: number;
}
export const PALETTE = PALETTES as unknown as { night: Palette; day: Palette };

// ── Small helpers ─────────────────────────────────────────────

type RGB = [number, number, number];
const rgbCache = new Map<string, RGB>();
const rgb = (hex: string): RGB => {
  let c = rgbCache.get(hex);
  if (!c) {
    c = [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
    rgbCache.set(hex, c);
  }
  return c;
};
const pack = (hex: string): number => {
  const [r, g, b] = rgb(hex);
  return ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0;
};
export { rgb };
const mixRgb = (a: RGB, b: RGB, t: number): RGB => [
  Math.round(a[0] + (b[0] - a[0]) * t),
  Math.round(a[1] + (b[1] - a[1]) * t),
  Math.round(a[2] + (b[2] - a[2]) * t),
];
const hex = (c: RGB) => `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`;

type Ctx = CanvasRenderingContext2D;
const rect = (c: Ctx, x: number, y: number, w: number, h: number, fill: string) => {
  c.fillStyle = fill;
  c.fillRect(Math.round(x), Math.round(y), w, h);
};
const disc = (c: Ctx, cx: number, cy: number, r: number, fill: string) => {
  c.fillStyle = fill;
  for (let dy = -r; dy <= r; dy++) {
    const w = Math.floor(Math.sqrt(r * r + r * 0.6 - dy * dy));
    c.fillRect(Math.round(cx - w), Math.round(cy + dy), w * 2 + 1, 1);
  }
};

const sprites = new Map<string, HTMLCanvasElement>();
/** A soft ellipse of light or shadow (rgb "r,g,b", strongest alpha k), drawn once and kept. */
function glowSprite(rx: number, ry: number, col: string, k: number): HTMLCanvasElement {
  const key = `${rx}|${ry}|${col}|${k}`;
  let s = sprites.get(key);
  if (!s) {
    if (sprites.size >= BG_SPRITE_CACHE_MAX) sprites.clear();
    s = document.createElement('canvas');
    s.width = rx * 2 + 1;
    s.height = ry * 2 + 1;
    const c = s.getContext('2d')!;
    for (let dy = -ry; dy <= ry; dy++)
      for (let dx = -rx; dx <= rx; dx++) {
        const d = (dx / rx) ** 2 + (dy / ry) ** 2;
        if (d >= 1) continue;
        const a = Math.round((1 - d) * k * 12) / 12;
        if (a <= 0) continue;
        c.fillStyle = rgbaOf(col, a);
        c.fillRect(dx + rx, dy + ry, 1, 1);
      }
    sprites.set(key, s);
  }
  return s;
}
const glow = (c: Ctx, x: number, y: number, rx: number, ry: number, col: string, k: number) =>
  c.drawImage(glowSprite(rx, ry, col, k), Math.round(x) - rx, Math.round(y) - ry);

// ── Boxes: towers and houses ─────────────────────────────────

/** A box standing on ground point (ax, ay), `tiles` square, `h` iso px tall. Its windows are
 *  bays at our building's scale (building-a-1104): a glass band a storey for a tower, one low
 *  band for a house; which are lit is a fixed pattern of the building (`seed`), the same in both
 *  palettes' colours. */
function isoBox(c: Ctx, ax: number, ay: number, tiles: number, h: number, col: Body, seed: number): void {
  const W = Math.round(tiles * ISO_HALF_W);
  const D = Math.round(W / 2);
  const left: Array<[number, number]> = [];
  const right: Array<[number, number]> = [];
  for (let k = 0; k < W; k++) {
    const x = ax - W + k;
    const tl = Math.round(ay - h + (k + 0.5) / 2);
    rect(c, x, tl, 1, h, col.left);
    left.push([x, tl]);
    const x2 = ax + k;
    const tr = Math.round(ay - h + D - (k + 0.5) / 2);
    rect(c, x2, tr, 1, h, col.right);
    right.push([x2, tr]);
  }
  c.fillStyle = col.top;
  for (let dy = -D; dy < D; dy++) {
    const hw = Math.round(((D - Math.abs(dy + 0.5)) * W) / D);
    c.fillRect(ax - hw, ay - h + dy, hw * 2, 1);
  }
  c.fillStyle = col.edge;
  for (let k = 0; k < W; k++) {
    c.fillRect(left[k][0], left[k][1], 1, 1);
    c.fillRect(right[k][0], right[k][1], 1, 1);
  }
  const tower = h >= ISO_STOREY_H;
  const storey = tower ? ISO_STOREY_H : h;
  const band = tower ? ISO_GLASS_BAND : BG_HOUSE_GLASS;
  for (const [cols, lit] of [
    [left, col.litL],
    [right, col.litR],
  ] as const)
    for (let k = BG_BAY_PX.inset; k < W - BG_BAY_PX.inset; k++) {
      if (k % BG_BAY_PX.every < BG_BAY_PX.mullion) continue;
      const [x, t] = cols[k];
      const bottom = t + h;
      for (let s = 0; bottom - (s + 1) * storey >= t - 1; s++) {
        const g0 = Math.max(t + 2, bottom - s * storey - band.to);
        const g1 = bottom - s * storey - band.from;
        const on = hash(Math.floor(k / BG_BAY_PX.every), s, seed) < col.p;
        if (g1 > g0) rect(c, x, g0, 1, g1 - g0, on ? lit : col.off);
      }
    }
}

/** A stepped pyramid roof over a box top whose centre is (cx, cy). */
function roof(c: Ctx, cx: number, cy: number, tiles: number, dark: string, light: string): void {
  const W = Math.round(tiles * ISO_HALF_W) + 2;
  for (let s = 0; s < BG_HOUSE_ROOF_STEPS; s++) {
    const w = W - s * Math.floor(W / (BG_HOUSE_ROOF_STEPS + 0.5));
    const d = Math.round(w / 2);
    for (let dy = -d; dy < d; dy++) {
      const hw = Math.round(((d - Math.abs(dy + 0.5)) * w) / d);
      const y = cy - s * 2 + dy;
      rect(c, cx - hw, y, hw, 1, dark);
      rect(c, cx, y, hw, 1, light);
    }
  }
}

function tree(c: Ctx, o: BgObject, g: { x: number; y: number }, P: Palette): void {
  const t = P.tree;
  glow(c, g.x + 2, g.y, 6, 3, t.shadow, 0.55);
  const tk = BG_TREE_TRUNK;
  rect(c, g.x - 1, g.y - tk.h, tk.w, tk.h, t.trunk);
  const r = o.size;
  disc(c, g.x, g.y - tk.h - r, r, t.leafD);
  disc(c, g.x - 1, g.y - tk.h - 1 - r, r - 1, t.leafM);
  disc(c, g.x - 2, g.y - tk.h - 2 - r, Math.max(1, Math.floor(r / 3)), t.leafL);
  if (t.spark && hash(o.pick, Math.round(g.x), 3) < 0.6) {
    rect(c, g.x + 2, g.y - 7, 1, 1, t.spark);
    rect(c, g.x - 3, g.y - 9, 1, 1, t.spark);
    rect(c, g.x + 1, g.y - 12, 1, 1, t.spark);
  }
  if (t.flower && hash(o.pick, Math.round(g.x), 4) < 0.7) {
    rect(c, g.x + 3, g.y - 6, 1, 1, t.flower);
    rect(c, g.x - 3, g.y - 8, 1, 1, t.flower);
  }
}

function lamp(c: Ctx, g: { x: number; y: number }, P: Palette): void {
  const l = P.lamp;
  if (l.poolK) glow(c, g.x, g.y, 14, 7, l.pool, l.poolK);
  rect(c, g.x, g.y - BG_LAMP_HEIGHT, 1, BG_LAMP_HEIGHT, l.pole);
  rect(c, g.x - 1, g.y - BG_LAMP_HEIGHT - 1, 3, 2, l.on);
  rect(c, g.x - 1, g.y - BG_LAMP_HEIGHT - 2, 3, 1, l.pole);
  if (l.halo) glow(c, g.x, g.y - BG_LAMP_HEIGHT - 1, 7, 6, l.halo, l.haloK);
}

// ── Ground ────────────────────────────────────────────────────

const KIND = { main: 0, empty: 1, tower: 2, houses: 3, park: 4, pond: 5 } as const satisfies Record<PlotKind, number>;

/** The ground of the region, per pixel, from the tile grid. */
function paintGround(c: Ctx, P: Palette, spec: PaintSpec): void {
  const { fp, region: r, seed, mix } = spec;
  const g = P.ground;
  const w = r.x1 - r.x0;
  const top = r.y0;
  const h = r.y1 - top;
  // The tile range of the region, and each axis' cell for every tile in it, once.
  const col = (x: number, y: number) => (x / ISO_HALF_W + y / ISO_HALF_H) / 2;
  const row = (x: number, y: number) => (y / ISO_HALF_H - x / ISO_HALF_W) / 2;
  const corners = [
    [r.x0, top],
    [r.x1, top],
    [r.x0, r.y1],
    [r.x1, r.y1],
  ];
  const imin = Math.floor(Math.min(...corners.map(([x, y]) => col(x, y)))) - 1;
  const imax = Math.ceil(Math.max(...corners.map(([x, y]) => col(x, y)))) + 1;
  const jmin = Math.floor(Math.min(...corners.map(([x, y]) => row(x, y)))) - 1;
  const jmax = Math.ceil(Math.max(...corners.map(([x, y]) => row(x, y)))) + 1;
  const cellsA = Array.from({ length: imax - imin + 1 }, (_, k) => axisCell(imin + k, fp.cols));
  const cellsB = Array.from({ length: jmax - jmin + 1 }, (_, k) => axisCell(jmin + k, fp.rows));
  const pa = cellsA.map((a) => a.plot);
  const pMinA = Math.min(...pa);
  const pMinB = Math.min(...cellsB.map((b) => b.plot));
  const spanA = Math.max(...pa) - pMinA + 1;
  const spanB = Math.max(...cellsB.map((b) => b.plot)) - pMinB + 1;
  const kinds = new Uint8Array(spanA * spanB);
  for (let ka = 0; ka < spanA; ka++)
    for (let kb = 0; kb < spanB; kb++) kinds[ka * spanB + kb] = KIND[plotKind(seed, mix, pMinA + ka, pMinB + kb)];

  const C = {
    road: pack(g.road), road2: pack(g.road2), dash: pack(g.dash), walk: pack(g.walk), walkJ: pack(g.walkJ),
    curb: pack(g.curb), plaza0: pack(g.plaza[0]), plaza1: pack(g.plaza[1]), plazaJ: pack(g.plazaJ),
    grass0: pack(g.grass[0]), grass1: pack(g.grass[1]), grass2: pack(g.grass[2]), lot: pack(g.lot),
    lotJ: pack(g.lotJ), water: pack(g.water), sand: pack(g.sand), ghost: pack(g.ghost),
    ghostJ: pack(g.ghostJ), ghostEdge: pack(g.ghostEdge), spark: pack(hex(mixRgb(rgb(g.water), [255, 255, 255], 0.5))),
  };
  const img = c.createImageData(w, h);
  const px = new Uint32Array(img.data.buffer);
  for (let y = top; y < r.y1; y++) {
    const rowOff = (y - top) * w;
    for (let x = r.x0; x < r.x1; x++) {
      const u = col(x + 0.5, y + 0.5);
      const v = row(x + 0.5, y + 0.5);
      const i = Math.floor(u);
      const j = Math.floor(v);
      const fu = u - i;
      const fv = v - j;
      const A = cellsA[i - imin];
      const B = cellsB[j - jmin];
      const noise = hash(x, y, 1);
      let out: number;
      if (A.road >= 0 || B.road >= 0) {
        out = ((x + y) & 7) === 0 && noise < 0.5 ? C.road2 : C.road;
        // The centre line, dashed, along each road but not across a crossing.
        if (A.road === 1 && B.road < 0 && fu > 0.42 && fu < 0.58 && (j & 1) === 0) out = C.dash;
        else if (B.road === 1 && A.road < 0 && fv > 0.42 && fv < 0.58 && (i & 1) === 0) out = C.dash;
      } else {
        const kind = kinds[(A.plot - pMinA) * spanB + (B.plot - pMinB)];
        const ringA = A.t === 0 || A.t === A.n - 1;
        const ringB = B.t === 0 || B.t === B.n - 1;
        if (ringA || ringB) {
          const curb =
            (A.t === 0 && fu < 0.14) || (A.t === A.n - 1 && fu > 0.86) || (B.t === 0 && fv < 0.14) || (B.t === B.n - 1 && fv > 0.86);
          out = curb ? C.curb : fu < 0.1 || fv < 0.1 ? C.walkJ : C.walk;
        } else if (kind === KIND.main) out = fu < 0.1 || fv < 0.1 ? C.plazaJ : (i + j) & 1 ? C.plaza1 : C.plaza0;
        else if (kind === KIND.tower) out = fu < 0.1 || fv < 0.1 ? C.lotJ : C.lot;
        else if (kind === KIND.empty) {
          const inner = (A.t === 1 && fu < 0.16) || (A.t === A.n - 2 && fu > 0.84) || (B.t === 1 && fv < 0.16) || (B.t === B.n - 2 && fv > 0.84);
          out = inner && (x + Math.floor(y * 2)) % 8 < 4 ? C.ghostEdge : fu < 0.1 || fv < 0.1 ? C.ghostJ : C.ghost;
        } else if (kind === KIND.pond && A.t > 2 && A.t < A.n - 3 && B.t > 2 && B.t < B.n - 3) {
          const rim = A.t === 3 || A.t === A.n - 4 || B.t === 3 || B.t === B.n - 4;
          out = rim ? C.sand : noise < 0.04 ? C.spark : C.water;
        } else {
          const q = hash(x >> 1, y >> 1, 2);
          out = q < 0.22 ? C.grass1 : q > 0.84 ? C.grass2 : C.grass0;
        }
      }
      px[rowOff + (x - r.x0)] = out;
    }
  }
  c.putImageData(img, 0, top - r.y0);
}

// ── The whole picture ───────────────────────────────────────

/** What shows beyond the painted part: the fog's own colour. */
export const edgeColour = (night: boolean): string => (night ? PALETTE.night : PALETTE.day).fog.body;

/** The depth a thing is sorted by: its front corner on the ground. */
const frontY = (o: BgObject): number =>
  groundAt(o.a, o.b).y + (o.kind === 'tower' || o.kind === 'house' ? o.size * ISO_HALF_H : 0);

function paintObject(c: Ctx, o: BgObject, P: Palette): void {
  const g = groundAt(o.a, o.b);
  if (o.kind === 'lamp') lamp(c, g, P);
  else if (o.kind === 'tree') tree(c, o, g, P);
  else if (o.kind === 'tower') isoBox(c, g.x, g.y, o.size, o.h, P.tower, o.pick);
  else {
    isoBox(c, g.x, g.y, o.size, o.h, P.house, o.pick);
    const [dark, light] = P.house.roofs[Math.floor(hash(o.pick, 5, 10) * P.house.roofs.length)];
    roof(c, g.x, g.y - o.h, o.size, dark, light);
  }
}

/** Paint the region of the world `spec` names. */
export function paintBackground(spec: PaintSpec): HTMLCanvasElement {
  const P = spec.night ? PALETTE.night : PALETTE.day;
  const { region: r, fp } = spec;
  const canvas = document.createElement('canvas');
  canvas.width = r.x1 - r.x0;
  canvas.height = r.y1 - r.y0;
  const c = canvas.getContext('2d')!;
  c.imageSmoothingEnabled = false;
  const centre = groundAt(fp.cols / 2, fp.rows / 2);

  paintGround(c, P, spec); // putImageData: in canvas px, whatever the transform
  c.translate(-r.x0, -r.y0); // from here on, iso px
  if (P.mainGlow) {
    const rx = Math.round(((fp.cols + fp.rows) * ISO_HALF_W) / 2);
    glow(c, centre.x, centre.y, rx, rx >> 1, P.mainGlow, P.mainGlowK);
  }
  // What can reach into this piece: a tower's ground may lie below it, its top inside.
  const reach = {
    x0: r.x0 - BG_OBJECT_REACH.x,
    x1: r.x1 + BG_OBJECT_REACH.x,
    y0: r.y0 - BG_OBJECT_REACH.y,
    y1: r.y1 + BG_TOWER_STOREYS.max * ISO_STOREY_H + BG_OBJECT_REACH.y,
  };
  const objects = objectsIn(spec.seed, spec.mix, fp, plotsIn(fp, reach), spec.avoid)
    .filter((o) => {
      const b = objectBox(o);
      return b.x1 > r.x0 - BG_OBJECT_REACH.x && b.x0 < r.x1 + BG_OBJECT_REACH.x && b.y1 > r.y0 - BG_OBJECT_REACH.y && b.y0 < r.y1;
    })
    .map((o) => ({ o, key: frontY(o) }))
    .sort((p, q) => p.key - q.key);
  for (const { o } of objects) paintObject(c, o, P);
  return canvas;
}
