/**
 * Photo -> pixel character (T-0017, FR-OFC-016). Pure and deterministic: the
 * browser crops and scales the photo, everything after that happens here.
 *
 * 1. Palette: k-means (k-means++ seeded) in OKLab on the crop at 32×32.
 * 2. Regions: the shipped template (template.ts), char_0 with its masks.
 * 3. Recolour, one palette colour per region. Shades of one thing (a gradient
 *    sky, lit and shaded fur) are grouped first: a colour joins the first more
 *    frequent colour of similar lightness, chroma and hue. The group touching
 *    the top and side edges most is the background: never hair or skin.
 *    - hair: the commonest colour in the upper middle of the photo;
 *    - skin: the commonest other skin-like colour in the centre, else char_0's
 *      own skin (a cat's face is its fur, already the hair);
 *    - top: the commonest other colour along the bottom of the photo (the
 *      background only when nothing else is there);
 *    - bottom: the commonest remaining colour, kept darker than the top
 *      (the trousers' colour also outlines the suit);
 *    - shoes: the darkest colour, kept dark.
 *    Each region keeps char_0's shading: its main colour becomes the target and
 *    every other step keeps its lightness offset and relative chroma.
 * 4. Mugshot: the crop at 16×16 in the same palette, for the agent card.
 */
import type { Lab, Rgb } from './color.js';
import { chroma, hue, labDistance2, lchToRgb, rgbToLab } from './color.js';
import type { Region, Sheet } from './template.js';
import { L_MIN, recolourSheet } from './template.js';

export const MIN_COLORS = 4;
export const MAX_COLORS = 16;
export const DEFAULT_COLORS = 8;
/** The palette is learnt on the crop scaled to this side. */
export const WORK_SIDE = 32;
export const MUGSHOT_SIDE = 16;
/** A colour counts as skin inside this OKLCh box. */
const SKIN = { L: [0.45, 0.93], C: [0.025, 0.17], h: [20, 95] } as const;
/** Ignore palette colours rarer than this share of the photo. */
const MIN_SHARE = 0.03;

export interface PaletteColor {
  rgb: Rgb;
  lab: Lab;
  /** Samples in the whole crop, on its top and side edges, in its upper
   *  middle (where hair is), its centre (the face) and its bottom quarter. */
  count: number;
  edge: number;
  top: number;
  middle: number;
  bottom: number;
}

export type Looks = Record<Region, Rgb | null>;

export interface Conversion {
  /** 112×96 RGBA, the char_N.png layout. */
  sheet: Uint8ClampedArray<ArrayBuffer>;
  /** 16×16 RGBA portrait. */
  mugshot: Uint8ClampedArray<ArrayBuffer>;
  palette: PaletteColor[];
  /** The colour each region was given (null = char_0's own). */
  looks: Looks;
}

/** Area-average an RGBA image to side×side (alpha-weighted). */
function downsample(src: Sheet, side: number): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(side * side * 4);
  for (let y = 0; y < side; y++) {
    const y0 = Math.floor((y * src.height) / side);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * src.height) / side));
    for (let x = 0; x < side; x++) {
      const x0 = Math.floor((x * src.width) / side);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * src.width) / side));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let yy = y0; yy < y1; yy++)
        for (let xx = x0; xx < x1; xx++) {
          const i = (yy * src.width + xx) * 4;
          const alpha = src.data[i + 3];
          r += src.data[i] * alpha;
          g += src.data[i + 1] * alpha;
          b += src.data[i + 2] * alpha;
          a += alpha;
        }
      const o = (y * side + x) * 4;
      if (a > 0) {
        out[o] = Math.round(r / a);
        out[o + 1] = Math.round(g / a);
        out[o + 2] = Math.round(b / a);
      }
      out[o + 3] = Math.round(a / ((y1 - y0) * (x1 - x0)));
    }
  }
  return out;
}

/** mulberry32: a small seeded PRNG, so the same photo gives the same palette. */
function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** k-means with k-means++ seeding; fewer centres when the points have fewer colours. */
export function kmeans(
  points: readonly Lab[],
  k: number,
  seed = 1,
  iterations = 24,
): { centers: Lab[]; labels: Int32Array } {
  const random = seeded(seed);
  const centers: Lab[] = [points[Math.floor(random() * points.length)]];
  const d2 = points.map((p) => labDistance2(p, centers[0]));
  while (centers.length < k) {
    const total = d2.reduce((sum, v) => sum + v, 0);
    if (total <= 1e-12) break;
    let r = random() * total;
    let pick = 0;
    for (; pick < points.length - 1; pick++) {
      r -= d2[pick];
      if (r <= 0) break;
    }
    centers.push(points[pick]);
    for (let i = 0; i < points.length; i++)
      d2[i] = Math.min(d2[i], labDistance2(points[i], points[pick]));
  }
  const labels = new Int32Array(points.length).fill(-1);
  for (let it = 0; it < iterations; it++) {
    let changed = false;
    for (let i = 0; i < points.length; i++) {
      let best = 0;
      let bestD = Infinity;
      for (let j = 0; j < centers.length; j++) {
        const d = labDistance2(points[i], centers[j]);
        if (d < bestD) {
          bestD = d;
          best = j;
        }
      }
      if (labels[i] !== best) {
        labels[i] = best;
        changed = true;
      }
    }
    if (!changed) break;
    const sums = centers.map(() => ({ L: 0, a: 0, b: 0, n: 0 }));
    for (let i = 0; i < points.length; i++) {
      const s = sums[labels[i]];
      s.L += points[i].L;
      s.a += points[i].a;
      s.b += points[i].b;
      s.n++;
    }
    sums.forEach((s, j) => {
      if (s.n) centers[j] = { L: s.L / s.n, a: s.a / s.n, b: s.b / s.n };
    });
  }
  return { centers, labels };
}

const toRgb = (c: Lab): Rgb => lchToRgb(c.L, chroma(c), hue(c));

/** Quantize the crop: palette colours sorted by frequency, with where they sit. */
export function paletteOf(crop: Sheet, colors: number, seed = 1): PaletteColor[] {
  const k = Math.min(MAX_COLORS, Math.max(MIN_COLORS, Math.round(colors)));
  const work = downsample(crop, WORK_SIDE);
  const points: Lab[] = [];
  const where: number[] = [];
  for (let i = 0; i < WORK_SIDE * WORK_SIDE; i++) {
    if (work[i * 4 + 3] < 128) continue;
    points.push(rgbToLab([work[i * 4], work[i * 4 + 1], work[i * 4 + 2]]));
    where.push(i);
  }
  if (!points.length) return [];
  const { centers, labels } = kmeans(points, k, seed);
  const out: PaletteColor[] = centers.map((lab) => ({
    rgb: toRgb(lab),
    lab,
    count: 0,
    edge: 0,
    top: 0,
    middle: 0,
    bottom: 0,
  }));
  const q = WORK_SIDE / 4;
  labels.forEach((j, n) => {
    const e = out[j];
    const x = where[n] % WORK_SIDE;
    const y = Math.floor(where[n] / WORK_SIDE);
    e.count++;
    if (y < 2 || x < 2 || x >= WORK_SIDE - 2) e.edge++;
    if (y < 2 * q && x >= q * 0.75 && x < WORK_SIDE - q * 0.75) e.top++;
    if (y >= q && y < 3 * q && x >= q && x < 3 * q) e.middle++;
    if (y >= 3 * q) e.bottom++;
  });
  return out.filter((e) => e.count > 0).sort((a, b) => b.count - a.count);
}

const outside = (v: number, [lo, hi]: readonly [number, number]) =>
  v < lo ? lo - v : v > hi ? v - hi : 0;
export const isSkinLike = (c: Lab) =>
  outside(c.L, SKIN.L) + outside(chroma(c), SKIN.C) + outside(hue(c), SKIN.h) === 0;

const withL = (c: Lab, L: number): Lab => ({ L, a: c.a, b: c.b });

/** Shades of one thing: close lightness and chroma, and close hue unless greyish. */
function similar(p: Lab, q: Lab): boolean {
  if (Math.abs(p.L - q.L) > 0.1 || Math.abs(chroma(p) - chroma(q)) > 0.05) return false;
  if (chroma(p) < 0.03 || chroma(q) < 0.03) return true;
  const dh = Math.abs(hue(p) - hue(q));
  return Math.min(dh, 360 - dh) <= 25;
}

/** Group a frequency-sorted palette: each colour joins the first similar group
 *  leader, else leads a new group. Stats are summed; the leader is the colour. */
function groupShades(palette: readonly PaletteColor[]): PaletteColor[] {
  const groups: PaletteColor[] = [];
  for (const c of palette) {
    const g = groups.find((leader) => similar(leader.lab, c.lab));
    if (!g) groups.push({ ...c });
    else for (const k of ['count', 'edge', 'top', 'middle', 'bottom'] as const) g[k] += c[k];
  }
  return groups;
}

/** The region rule (see the header). Palette sorted by frequency. */
function pickLooks(palette: readonly PaletteColor[]): Looks {
  const total = palette.reduce((sum, c) => sum + c.count, 0);
  const usable = groupShades(palette).filter((c) => c.count >= total * MIN_SHARE);
  const by = (list: PaletteColor[], score: (c: PaletteColor) => number) =>
    list.reduce<PaletteColor | null>(
      (best, c) => (!best || score(c) > score(best) ? c : best),
      null,
    );
  const edgy = by(usable, (c) => c.edge);
  const background = edgy && edgy.edge > 0 ? edgy : null;
  const subject = usable.filter((c) => c !== background);
  const hair = by(subject, (c) => c.top) ?? background;
  const skin = by(
    subject.filter((c) => c !== hair && isSkinLike(c.lab) && c.middle > 0),
    (c) => c.middle,
  );
  const rest = usable.filter((c) => c !== hair && c !== skin);
  const top =
    by(
      rest.filter((c) => c !== background),
      (c) => c.bottom,
    ) ??
    background ??
    hair;
  const bottom = rest.find((c) => c !== top) ?? top;
  const darkest = by(
    usable.filter((c) => c !== skin),
    (c) => -c.lab.L,
  );
  if (!hair || !top || !bottom || !darkest)
    return { hair: null, skin: null, top: null, bottom: null, shoes: null };
  const topLab = top.lab;
  const bottomL = Math.min(bottom.lab.L, 0.55, topLab.L - 0.1);
  return {
    hair: hair.rgb,
    skin: skin ? toRgb(skinTone(skin.lab)) : null,
    top: top.rgb,
    bottom:
      bottomL < bottom.lab.L ? toRgb(withL(bottom.lab, Math.max(L_MIN, bottomL))) : bottom.rgb,
    shoes: darkest.lab.L > 0.3 ? toRgb(withL(darkest.lab, 0.3)) : darkest.rgb,
  };
}

/** A photo's skin colour pulled into a friendly range (bad light makes grey faces). */
function skinTone(c: Lab): Lab {
  const C = Math.min(0.12, Math.max(0.05, chroma(c)));
  const h = (Math.min(75, Math.max(35, hue(c))) * Math.PI) / 180;
  return { L: Math.min(0.88, Math.max(0.5, c.L)), a: C * Math.cos(h), b: C * Math.sin(h) };
}

/** The crop at 16×16, each pixel snapped to the nearest palette colour. */
function mugshotOf(crop: Sheet, palette: readonly PaletteColor[]): Uint8ClampedArray<ArrayBuffer> {
  const small = downsample(crop, MUGSHOT_SIDE);
  for (let i = 0; i < MUGSHOT_SIDE * MUGSHOT_SIDE; i++) {
    const lab = rgbToLab([small[i * 4], small[i * 4 + 1], small[i * 4 + 2]]);
    let best = palette[0];
    for (const c of palette) if (labDistance2(lab, c.lab) < labDistance2(lab, best.lab)) best = c;
    if (best) small.set(best.rgb, i * 4);
    small[i * 4 + 3] = small[i * 4 + 3] < 128 ? 0 : 255;
  }
  return small;
}

export function convertPhoto(crop: Sheet, colors = DEFAULT_COLORS, seed = 1): Conversion {
  const palette = paletteOf(crop, colors, seed);
  const looks = pickLooks(palette);
  return { sheet: recolourSheet(looks), mugshot: mugshotOf(crop, palette), palette, looks };
}
