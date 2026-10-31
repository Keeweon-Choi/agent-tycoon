/**
 * BACKGROUND painter: the surroundings of the isometric building as one offscreen picture, one
 * canvas px per iso px (the renderer scales it by the zoom, nearest-neighbour, like every other
 * piece). The ground is classified per pixel from the layout's tile grid (layout.ts), so roads,
 * pavements and plots sit exactly on the building's own floor tiles; what stands on it is drawn
 * back to front; the sky, far hills and skyline are stateless functions of the iso x, so a wider
 * picture only adds to the sides. One layout, two palettes (palette.json): the palette is the
 * only thing that differs between day and night.
 */
import type { BackgroundMix } from '../../../../../core/src/messages.js';
import {
  BG_CLOUD_CELL,
  BG_HAZE_H,
  BG_HILLS,
  BG_HORIZON_ABOVE,
  BG_HOUSE_ROOF_STEPS,
  BG_LAMP_HEIGHT,
  BG_MOON,
  BG_OBJECT_REACH,
  BG_SKY_H,
  BG_SKYLINE_H,
  BG_SKYLINE_SCALE,
  BG_SKYLINE_SLOTS,
  BG_SPRITE_CACHE_MAX,
  BG_STAR_CELL,
  BG_SUN,
  BG_TOWER_H_MAX,
  ISO_HALF_H,
  ISO_HALF_W,
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

interface Skyline {
  body: string;
  top: string;
  lit: string;
  off: string;
  pLit: number;
  pOff: number;
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
  sky: string[];
  stars: string[];
  moon: { disc: string; crater: string; pit: string; glow: string; glowK: number } | null;
  sun: { disc: string; glow: string; glowK: number } | null;
  cloud: { white: string; soft: string; shade: string } | null;
  hills: string[];
  skyline: Skyline[];
  haze: string;
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
const PALETTE = PALETTES as unknown as { night: Palette; day: Palette };

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
const mixRgb = (a: RGB, b: RGB, t: number): RGB => [
  Math.round(a[0] + (b[0] - a[0]) * t),
  Math.round(a[1] + (b[1] - a[1]) * t),
  Math.round(a[2] + (b[2] - a[2]) * t),
];
const hex = (c: RGB) => `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`;

/** 4 x 4 ordered dither: the sky and haze step between colours in a pixel pattern, no blur. */
const BAYER = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
].map((row) => row.map((v) => (v + 0.5) / 16));
const bay = (x: number, y: number) => BAYER[y & 3][x & 3];

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

/** A box standing on ground point (ax, ay), `tiles` square, `h` iso px tall. Windows are a
 *  fixed pattern of the building (`seed`): a lit one stays lit in both palettes' colours. */
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
  for (const [cols, lit] of [
    [left, col.litL],
    [right, col.litR],
  ] as const)
    for (let k = 3; k < W - 3; k += 4) {
      const [x, t] = cols[k];
      for (let y = t + 3; y < t + h - 2; y += 5)
        rect(c, x, y, 2, 2, hash(x, y, seed) < col.p ? lit : col.off);
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
  rect(c, g.x - 1, g.y - 5, 2, 5, t.trunk);
  const r = o.size;
  disc(c, g.x, g.y - 5 - r, r, t.leafD);
  disc(c, g.x - 1, g.y - 6 - r, r - 1, t.leafM);
  disc(c, g.x - 2, g.y - 8 - r + 1, Math.max(1, Math.floor(r / 3)), t.leafL);
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

// ── Sky ───────────────────────────────────────────────────────

/** The skyline layer's building in slot `c`: stateless, so it is the same in any picture. */
function skylineSlot(layer: number, c: number, seed: number, scale: number) {
  const slot = BG_SKYLINE_SLOTS[layer];
  const w = Math.round(slot * (0.62 + 0.38 * hash(c, layer, seed + 11)));
  const x = c * slot + Math.floor((slot - w) * hash(c, layer, seed + 12));
  const [lo, hi] = BG_SKYLINE_H[layer];
  const h = Math.round((lo + (hi - lo) * hash(c, layer, seed + 13)) * scale);
  return { x, w, h, ant: hash(c, layer, seed + 14) < 0.22, cap: hash(c, layer, seed + 15) < 0.3 };
}

function paintSkyline(c: Ctx, layer: number, P: Palette, spec: PaintSpec, yH: number): void {
  const s = P.skyline[layer];
  const scale = BG_SKYLINE_SCALE[spec.mix];
  const base = yH + layer * 2;
  const slot = BG_SKYLINE_SLOTS[layer];
  const { x0, x1 } = spec.region;
  for (let k = Math.floor(x0 / slot) - 1; k <= Math.floor(x1 / slot) + 1; k++) {
    const b = skylineSlot(layer, k, spec.seed, scale);
    rect(c, b.x, base - b.h, b.w, b.h, s.body);
    rect(c, b.x, base - b.h, b.w, 1, s.top);
    if (b.ant) rect(c, b.x + (b.w >> 1), base - b.h - 7, 1, 7, s.top);
    else if (b.cap) rect(c, b.x + 1, base - b.h - 2, Math.max(2, b.w - 3), 2, s.top);
    for (let wx = b.x + 2; wx < b.x + b.w - 2; wx += 3)
      for (let wy = base - b.h + 3; wy < base - 2; wy += 4) {
        const q = hash(wx, wy, spec.seed + layer);
        if (q < s.pLit) rect(c, wx, wy, 1, 2, s.lit);
        else if (q < s.pLit + s.pOff) rect(c, wx, wy, 1, 2, s.off);
      }
  }
}

function paintSky(c: Ctx, P: Palette, spec: PaintSpec, yH: number, centreX: number): void {
  const { x0, y0, x1 } = spec.region;
  // The gradient, dithered: the first stop at the top (BG_SKY_H above the horizon), the last at the horizon.
  const stops = P.sky.map(rgb);
  const n = stops.length - 1;
  for (let y = y0; y < yH; y++) {
    const f = Math.max(0, Math.min(1, 1 - (yH - y) / BG_SKY_H)) * n;
    const i = Math.min(n - 1, Math.floor(f));
    const fr = f - i;
    let run = x0;
    let cur = fr > bay(x0, y);
    for (let x = x0 + 1; x <= x1; x++) {
      const up = x < x1 && fr > bay(x, y);
      if (up === cur && x < x1) continue;
      c.fillStyle = hex(cur ? stops[i + 1] : stops[i]);
      c.fillRect(run, y, x - run, 1);
      run = x;
      cur = up;
    }
  }
  // Stars, one per cell of BG_STAR_CELL at most.
  if (P.stars.length) {
    for (let cx = Math.floor(x0 / BG_STAR_CELL); cx <= Math.floor(x1 / BG_STAR_CELL); cx++)
      for (let cy = Math.floor((y0 - 1) / BG_STAR_CELL); cy * BG_STAR_CELL < yH - 4; cy++) {
        if (hash(cx, cy, spec.seed + 21) > 0.62) continue;
        const x = cx * BG_STAR_CELL + Math.floor(hash(cx, cy, spec.seed + 22) * BG_STAR_CELL);
        const y = cy * BG_STAR_CELL + Math.floor(hash(cx, cy, spec.seed + 23) * BG_STAR_CELL);
        if (y > yH - 10) continue;
        const q = hash(cx, cy, spec.seed + 24);
        const col = P.stars[q < 0.6 ? 0 : q < 0.9 ? 1 : 2];
        rect(c, x, y, 1, 1, col);
        if (q > 0.93) {
          rect(c, x - 1, y, 3, 1, P.stars[1]);
          rect(c, x, y - 1, 1, 3, P.stars[1]);
        }
      }
  }
  if (P.moon && Math.abs(centreX + BG_MOON.dx - (x0 + x1) / 2) < (x1 - x0) / 2 + 30) {
    const m = P.moon;
    const mx = Math.round(centreX + BG_MOON.dx);
    const my = yH - BG_MOON.up;
    glow(c, mx, my, 24, 24, m.glow, m.glowK);
    disc(c, mx, my, BG_MOON.r, m.disc);
    const r = BG_MOON.r;
    c.fillStyle = m.crater;
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++)
        if (dx * dx + dy * dy <= r * r - 1 && (dx + 4) ** 2 + (dy + 4) ** 2 > 72) c.fillRect(mx + dx, my + dy, 1, 1);
    disc(c, mx - 3, my + 2, 1, m.pit);
    disc(c, mx + 3, my - 3, 1, m.pit);
  }
  if (P.sun && Math.abs(centreX + BG_SUN.dx - (x0 + x1) / 2) < (x1 - x0) / 2 + 30) {
    const sx = Math.round(centreX + BG_SUN.dx);
    const sy = yH - BG_SUN.up;
    disc(c, sx, sy, BG_SUN.r, P.sun.disc);
    glow(c, sx, sy, 22, 22, P.sun.glow, P.sun.glowK);
  }
  if (P.cloud) {
    const cl = P.cloud;
    const { w, h, up, rows, chance } = BG_CLOUD_CELL;
    for (let cx = Math.floor(x0 / w) - 1; cx <= Math.floor(x1 / w); cx++)
      for (let r = 0; r < rows; r++) {
        if (hash(cx, r, spec.seed + 31) > chance) continue;
        const x = cx * w + Math.floor(hash(cx, r, spec.seed + 32) * w);
        const y = yH - up - r * h + Math.floor(hash(cx, r, spec.seed + 33) * (h / 2));
        for (const [col, dy] of [[cl.shade, 2], [hash(cx, r, 34) < 0.5 ? cl.white : cl.soft, 0]] as const) {
          disc(c, x, y + dy, 5, col);
          disc(c, x + 6, y - 2 + dy, 6, col);
          disc(c, x + 13, y + dy, 5, col);
          disc(c, x + 7, y + 3 + dy, 4, col);
        }
      }
  }
  // Hills: sine sums, the same at any x.
  BG_HILLS.forEach((hl, k) => {
    c.fillStyle = P.hills[k];
    const phase = (spec.seed % 97) * (k + 1.3);
    for (let x = x0; x < x1; x++) {
      const y = Math.round(yH - hl.base - hl.amp * (0.5 + 0.5 * Math.sin(x * hl.freq + phase) + 0.35 * Math.sin(x * hl.freq * 2.3 + phase * 2)));
      c.fillRect(x, y, 1, yH + 4 - y);
    }
  });
  for (let layer = 0; layer < P.skyline.length; layer++) paintSkyline(c, layer, P, spec, yH);
}

// ── Ground ────────────────────────────────────────────────────

const KIND = { main: 0, empty: 1, tower: 2, houses: 3, park: 4, pond: 5 } as const satisfies Record<PlotKind, number>;

/** The ground of the region, per pixel, from the tile grid. */
function paintGround(c: Ctx, P: Palette, spec: PaintSpec, yH: number): void {
  const { fp, region: r, seed, mix } = spec;
  const g = P.ground;
  const w = r.x1 - r.x0;
  const top = Math.max(r.y0, yH);
  const h = r.y1 - top;
  if (h <= 0) return;
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

/** Iso px of the horizon: above the back corner of the first floor. */
export const horizonY = (): number => -BG_HORIZON_ABOVE;

/** What shows beyond the painted part: the sky's top colour, the road. */
export const edgeColours = (night: boolean): { sky: string; ground: string } => {
  const P = night ? PALETTE.night : PALETTE.day;
  return { sky: P.sky[0], ground: P.ground.road };
};

/** A dithered veil of `fill` over the rows y0..y1, full at the top, gone at the bottom. */
function haze(c: Ctx, x0: number, x1: number, y0: number, y1: number, fill: string): void {
  const [r, g, b] = rgb(fill);
  const levels = 5;
  for (let l = 1; l <= levels; l++) {
    c.fillStyle = rgbaOf(`${r},${g},${b}`, l / levels);
    for (let y = y0; y < y1; y++) {
      const f = (1 - (y - y0) / (y1 - y0)) * levels;
      const lv = Math.floor(f);
      for (let x = x0; x < x1; x++) if (lv + (f - lv > bay(x, y) ? 1 : 0) === l) c.fillRect(x, y, 1, 1);
    }
  }
}

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
  const yH = horizonY();
  const centre = groundAt(fp.cols / 2, fp.rows / 2);

  paintGround(c, P, spec, yH); // putImageData: in canvas px, whatever the transform
  c.translate(-r.x0, -r.y0); // from here on, iso px
  paintSky(c, P, spec, yH, (spec.avoid.x0 + spec.avoid.x1) / 2);
  if (P.mainGlow) {
    const rx = Math.round(((fp.cols + fp.rows) * ISO_HALF_W) / 2);
    glow(c, centre.x, centre.y, rx, rx >> 1, P.mainGlow, P.mainGlowK);
  }
  // What can reach into this piece: a tower's ground may lie below it, its top inside.
  const reach = {
    x0: r.x0 - BG_OBJECT_REACH.x,
    x1: r.x1 + BG_OBJECT_REACH.x,
    y0: r.y0 - BG_OBJECT_REACH.y,
    y1: r.y1 + BG_TOWER_H_MAX + BG_OBJECT_REACH.y,
  };
  const objects = objectsIn(spec.seed, spec.mix, fp, plotsIn(fp, reach), spec.avoid)
    .filter((o) => {
      if (groundAt(o.a, o.b).y < yH + 4) return false;
      const b = objectBox(o);
      return b.x1 > r.x0 - BG_OBJECT_REACH.x && b.x0 < r.x1 + BG_OBJECT_REACH.x && b.y1 > r.y0 - BG_OBJECT_REACH.y && b.y0 < r.y1;
    })
    .map((o) => ({ o, key: frontY(o) }))
    .sort((p, q) => p.key - q.key);
  let hazed = false;
  const veil = () => {
    haze(c, r.x0, r.x1, Math.max(r.y0, yH), Math.min(r.y1, yH + BG_HAZE_H), P.haze);
    hazed = true;
  };
  for (const { o, key } of objects) {
    if (!hazed && key > yH + BG_HAZE_H) veil();
    paintObject(c, o, P);
  }
  if (!hazed) veil();
  return canvas;
}
